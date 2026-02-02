import Foundation
import ManagedSettings

actor PaywallService {
    static let shared = PaywallService()

    private let db = DatabaseProvider.shared.dbQueue
    private let store = ManagedSettingsStore()
    private let notifications = NotificationService.shared

    func activeSessions() async -> [PaywallSession] {
        await db.read { db in
            let rows = try PaywallSessionRow.fetchAll(db)
            return rows.map { row in
                PaywallSession(id: UUID(uuidString: row.id) ?? UUID(), targetId: row.targetId, targetName: row.targetName, mode: PaywallMode(rawValue: row.mode) ?? .pack, remainingSeconds: row.remainingSeconds, purchasedSeconds: row.purchasedSeconds, startedAt: row.startedAt, expiresAt: row.expiresAt, paused: row.paused, lastUpdated: row.lastUpdated)
            }
        }
    }

    func buyPack(target: FrivolityTarget, minutes: Int, price: Int) async -> PaywallSession? {
        let now = Date()
        let duration = minutes * 60
        let expiry = now.addingTimeInterval(TimeInterval(duration))
        let session = PaywallSession(targetId: target.id, targetName: target.displayName, mode: .pack, remainingSeconds: duration, purchasedSeconds: duration, startedAt: now, expiresAt: expiry, paused: false)
        let row = PaywallSessionRow(id: session.id.uuidString, targetId: target.id, targetName: target.displayName, mode: session.mode.rawValue, remainingSeconds: session.remainingSeconds, purchasedSeconds: session.purchasedSeconds, startedAt: session.startedAt, expiresAt: session.expiresAt, paused: session.paused, lastUpdated: session.lastUpdated)
        await db.write { db in
            try? row.insert(db)
            let tx = WalletTransaction(type: .spend, amount: price, meta: ["minutes": "\(minutes)", "target": target.displayName])
            try? WalletService.shared.record(transaction: tx, db)
        }
        unshield(target: target)
        await notifications.scheduleExpiryAlerts(for: session)
        return session
    }

    func tickSessions() async {
        let now = Date()
        await db.write { db in
            var sessions = try PaywallSessionRow.fetchAll(db)
            for idx in sessions.indices {
                var session = sessions[idx]
                guard !session.paused else { continue }
                let remaining = Int(session.expiresAt.timeIntervalSince(now))
                if remaining <= 0 {
                    // expire
                    try? PaywallSessionRow.deleteOne(db, key: session.id)
                    notifications.cancelAlerts(forSessionId: session.id)
                    shield(targetId: session.targetId)
                } else {
                    session.remainingSeconds = remaining
                    session.lastUpdated = now
                    try? session.update(db)
                }
            }
        }
    }

    func shield(targetId: String) {
        let targets = FamilyControlsService.shared.selection
        let apps = targets.applicationTokens.filter { $0.hashValue.description == targetId }
        let domains = targets.webDomainTokens.filter { $0.hashValue.description == targetId }
        store.shield.applications = Set(apps)
        store.shield.webDomains = Set(domains)
    }

    func unshield(target: FrivolityTarget) {
        if let token = target.token {
            switch target.kind {
            case .appToken:
                store.shield.applications?.remove(token)
            case .webDomainToken:
                store.shield.webDomains?.remove(token)
            }
        }
    }
}
