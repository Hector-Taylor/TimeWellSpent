import Foundation

public struct PackPrice: Codable, Hashable, Identifiable {
    public var id: Int { minutes }
    public let minutes: Int
    public let price: Int
}

public struct MarketRate: Codable, Identifiable, Hashable {
    public var id: String { targetId }
    public let targetId: String
    public var ratePerMin: Int
    public var packs: [PackPrice]
    public var hourlyModifiers: [Double]

    public init(targetId: String, ratePerMin: Int = 6, packs: [PackPrice] = [PackPrice(minutes: 10, price: 25), PackPrice(minutes: 30, price: 60), PackPrice(minutes: 60, price: 100)], hourlyModifiers: [Double] = Array(repeating: 1.0, count: 24)) {
        self.targetId = targetId
        self.ratePerMin = ratePerMin
        self.packs = packs
        self.hourlyModifiers = hourlyModifiers.count == 24 ? hourlyModifiers : Array(repeating: 1.0, count: 24)
    }
}
