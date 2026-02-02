import Foundation

public enum TransactionType: String, Codable { case earn, spend, adjust }

public struct WalletTransaction: Codable, Identifiable, Equatable {
    public let id: UUID
    public let ts: Date
    public let type: TransactionType
    public let amount: Int
    public let meta: [String: String]
    public let syncId: String?

    public init(id: UUID = UUID(), ts: Date = Date(), type: TransactionType, amount: Int, meta: [String: String] = [:], syncId: String? = nil) {
        self.id = id
        self.ts = ts
        self.type = type
        self.amount = amount
        self.meta = meta
        self.syncId = syncId
    }
}

public struct WalletSnapshot: Codable {
    public let balance: Int
    public let lastSyncAt: Date?
    public let stale: Bool
}

public struct ConsumptionEvent: Codable, Identifiable {
    public enum Kind: String, Codable { case packPurchase = "pack-purchase"; case paywallStarted = "paywall-session-started"; case paywallEnded = "paywall-session-ended"; case paywallDecline = "paywall-decline" }
    public let id: UUID
    public let occurredAt: Date
    public let kind: Kind
    public let title: String?
    public let domain: String?
    public let meta: [String: String]?
}
