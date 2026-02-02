import Foundation
import GRDB

public final class DatabaseProvider {
    public static let shared = DatabaseProvider()
    public let dbQueue: DatabaseQueue

    private init() {
        let container = AppGroupContainer.containerURL().appendingPathComponent("Database", isDirectory: true)
        try? FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        let url = container.appendingPathComponent("timewellspent.sqlite")
        dbQueue = try! DatabaseQueue(path: url.path)
        migrate()
    }

    private func migrate() {
        var migrator = DatabaseMigrator()

        migrator.registerMigration("wallet_v1") { db in
            try db.create(table: "wallet_transactions") { t in
                t.column("id", .text).primaryKey()
                t.column("ts", .datetime).notNull()
                t.column("type", .text).notNull()
                t.column("amount", .integer).notNull()
                t.column("meta", .text)
                t.column("sync_id", .text)
                t.column("device_id", .text)
            }
        }

        migrator.registerMigration("targets_v1") { db in
            try db.create(table: "targets") { t in
                t.column("id", .text).primaryKey()
                t.column("kind", .text).notNull()
                t.column("display_name", .text).notNull()
                t.column("token_data", .blob).notNull()
                t.column("unshielded_until", .datetime)
            }
        }

        migrator.registerMigration("market_v1") { db in
            try db.create(table: "market_rates") { t in
                t.column("target_id", .text).primaryKey()
                t.column("rate_per_min", .integer).notNull()
                t.column("packs_json", .text).notNull()
                t.column("hourly_modifiers_json", .text).notNull()
                t.column("updated_at", .datetime).notNull()
            }
        }

        migrator.registerMigration("paywall_v1") { db in
            try db.create(table: "paywall_sessions") { t in
                t.column("id", .text).primaryKey()
                t.column("target_id", .text).notNull()
                t.column("target_name", .text).notNull()
                t.column("mode", .text).notNull()
                t.column("remaining_seconds", .integer).notNull()
                t.column("purchased_seconds", .integer).notNull()
                t.column("started_at", .datetime).notNull()
                t.column("expires_at", .datetime).notNull()
                t.column("paused", .boolean).notNull().defaults(to: false)
                t.column("last_updated", .datetime).notNull()
            }
        }

        migrator.registerMigration("consumption_v1") { db in
            try db.create(table: "consumption_log") { t in
                t.column("id", .text).primaryKey()
                t.column("occurred_at", .datetime).notNull()
                t.column("kind", .text).notNull()
                t.column("title", .text)
                t.column("domain", .text)
                t.column("meta", .text)
            }
        }

        do {
            try migrator.migrate(dbQueue)
        } catch {
            print("[DB] migration failed: \(error)")
        }
    }
}

// MARK: - Row models

struct WalletRow: FetchableRecord, PersistableRecord {
    static let databaseTableName = "wallet_transactions"
    var id: String
    var ts: Date
    var type: String
    var amount: Int
    var meta: String?
    var syncId: String?
    var deviceId: String?
}

struct TargetRow: FetchableRecord, PersistableRecord {
    static let databaseTableName = "targets"
    var id: String
    var kind: String
    var displayName: String
    var tokenData: Data
    var unshieldedUntil: Date?
}

struct MarketRow: FetchableRecord, PersistableRecord {
    static let databaseTableName = "market_rates"
    var targetId: String
    var ratePerMin: Int
    var packsJson: String
    var hourlyModifiersJson: String
    var updatedAt: Date
}

struct PaywallSessionRow: FetchableRecord, PersistableRecord {
    static let databaseTableName = "paywall_sessions"
    var id: String
    var targetId: String
    var targetName: String
    var mode: String
    var remainingSeconds: Int
    var purchasedSeconds: Int
    var startedAt: Date
    var expiresAt: Date
    var paused: Bool
    var lastUpdated: Date
}

struct ConsumptionRow: FetchableRecord, PersistableRecord {
    static let databaseTableName = "consumption_log"
    var id: String
    var occurredAt: Date
    var kind: String
    var title: String?
    var domain: String?
    var meta: String?
}
