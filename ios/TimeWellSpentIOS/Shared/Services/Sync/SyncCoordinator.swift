import Foundation

actor SyncCoordinator {
    static let shared = SyncCoordinator()

    private let db = DatabaseProvider.shared.dbQueue
    private let supabase = SupabaseClientProvider.shared.client
    private(set) var lastSyncAt: Date?

    var isSignedIn: Bool {
        (try? supabase?.auth.session() != nil) ?? false
    }

    func signIn() async -> String? {
        guard let client = supabase else { return "Supabase config missing" }
        do {
            _ = try await client.auth.signInWithOAuth(provider: .google)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func signOut() async {
        try? await supabase?.auth.signOut()
    }

    func syncNow() async {
        guard let client = supabase else { return }
        await syncWallet(client: client)
    }

    private func syncWallet(client: SupabaseClient) async {
        do {
            let local = try await db.read { db in try WalletRow.fetchAll(db) }
            let lastTs = local.map { $0.ts }.max() ?? Date(timeIntervalSince1970: 0)
            // Pull remote newer
            let fromIso = ISO8601DateFormatter().string(from: lastTs)
            let remote = try await client.database.from("wallet_transactions").select().gte(column: "ts", value: fromIso).execute().value
            if let array = remote as? [[String: Any]] {
                try await db.write { db in
                    for item in array {
                        guard let id = item["id"] as? String,
                              let tsStr = item["ts"] as? String,
                              let ts = ISO8601DateFormatter().date(from: tsStr),
                              let type = item["type"] as? String,
                              let amount = item["amount"] as? Int else { continue }
                        let meta = (item["meta"] as? [String: String]) ?? [:]
                        let row = WalletRow(id: id, ts: ts, type: type, amount: amount, meta: try? String(data: JSONEncoder().encode(meta), encoding: .utf8), syncId: item["sync_id"] as? String, deviceId: item["device_id"] as? String)
                        try? row.insert(db)
                    }
                }
            }
            // Upload locals missing syncId
            let unsynced = local.filter { $0.syncId == nil }
            for tx in unsynced {
                var payload: [String: Any] = [
                    "id": tx.id,
                    "ts": ISO8601DateFormatter().string(from: tx.ts),
                    "type": tx.type,
                    "amount": tx.amount,
                    "meta": tx.meta ?? "{}",
                    "device_id": DeviceIdentity.shared.id
                ]
                if let syncId = tx.syncId { payload["sync_id"] = syncId }
                _ = try await client.database.from("wallet_transactions").insert(values: payload).execute()
            }
            lastSyncAt = Date()
        } catch {
            print("[Sync] wallet sync failed: \(error)")
        }
    }
}
