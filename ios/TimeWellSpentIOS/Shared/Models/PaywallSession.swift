import Foundation

public enum PaywallMode: String, Codable { case pack, emergency, store }

public struct PaywallSession: Codable, Identifiable {
    public let id: UUID
    public let targetId: String
    public let targetName: String
    public let mode: PaywallMode
    public var remainingSeconds: Int
    public var purchasedSeconds: Int
    public var startedAt: Date
    public var expiresAt: Date
    public var paused: Bool
    public var lastUpdated: Date

    public init(id: UUID = UUID(), targetId: String, targetName: String, mode: PaywallMode, remainingSeconds: Int, purchasedSeconds: Int, startedAt: Date, expiresAt: Date, paused: Bool = false, lastUpdated: Date = Date()) {
        self.id = id
        self.targetId = targetId
        self.targetName = targetName
        self.mode = mode
        self.remainingSeconds = remainingSeconds
        self.purchasedSeconds = purchasedSeconds
        self.startedAt = startedAt
        self.expiresAt = expiresAt
        self.paused = paused
        self.lastUpdated = lastUpdated
    }
}
