import Foundation
import GRDB

actor MarketService {
    static let shared = MarketService()
    private let db = DatabaseProvider.shared.dbQueue

    func listRates() async -> [MarketRate] {
        await db.read { db in
            let rows = try MarketRow.fetchAll(db)
            return rows.map { row in
                let packs = (try? JSONDecoder().decode([PackPrice].self, from: Data(row.packsJson.utf8))) ?? []
                let modifiers = (try? JSONDecoder().decode([Double].self, from: Data(row.hourlyModifiersJson.utf8))) ?? Array(repeating: 1.0, count: 24)
                return MarketRate(targetId: row.targetId, ratePerMin: row.ratePerMin, packs: packs, hourlyModifiers: modifiers)
            }
        }
    }

    func upsert(rate: MarketRate) async {
        await db.write { db in
            let packsData = try JSONEncoder().encode(rate.packs)
            let modifiersData = try JSONEncoder().encode(rate.hourlyModifiers)
            let row = MarketRow(targetId: rate.targetId, ratePerMin: rate.ratePerMin, packsJson: String(data: packsData, encoding: .utf8) ?? "[]", hourlyModifiersJson: String(data: modifiersData, encoding: .utf8) ?? "[]", updatedAt: Date())
            try row.save(db)
        }
    }
}
