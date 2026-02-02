import Foundation

public struct FriendProfile: Codable, Identifiable, Hashable {
    public let id: String
    public let handle: String?
    public let displayName: String?
    public let color: String?
}

public struct FriendRequest: Codable, Identifiable, Hashable {
    public let id: String
    public let userId: String
    public let handle: String?
    public let displayName: String?
    public let direction: String
    public let status: String
    public let createdAt: Date
}

public struct FriendConnection: Codable, Identifiable, Hashable {
    public let id: String
    public let userId: String
    public let handle: String?
    public let displayName: String?
    public let color: String?
    public let createdAt: Date
}
