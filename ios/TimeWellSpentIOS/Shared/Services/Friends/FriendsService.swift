import Foundation

actor FriendsService {
    static let shared = FriendsService()
    private let client = SupabaseClientProvider.shared.client

    func list() async -> [FriendConnection] {
        guard let client else { return [] }
        do {
            let data = try await client.database.from("friends").select().execute().value
            guard let rows = data as? [[String: Any]] else { return [] }
            return rows.compactMap { row in
                guard let id = row["id"] as? String, let userId = row["friend_id"] as? String, let created = row["created_at"] as? String, let createdAt = ISO8601DateFormatter().date(from: created) else { return nil }
                return FriendConnection(id: id, userId: userId, handle: row["handle"] as? String, displayName: row["display_name"] as? String, color: row["color"] as? String, createdAt: createdAt)
            }
        } catch {
            print("[Friends] list failed: \(error)")
            return []
        }
    }
}
