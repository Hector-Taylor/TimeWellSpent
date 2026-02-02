import Foundation
import GRDB

actor WalletService {
    static let shared = WalletService()
    private let db = DatabaseProvider.shared.dbQueue

    func currentBalance() async -> Int {
        await db.read { db in
            let rows = try WalletRow.fetchAll(db)
            let balance = rows.reduce(0) { partial, row in
                switch row.type {
                case TransactionType.earn.rawValue: return partial + row.amount
                case TransactionType.spend.rawValue: return partial - row.amount
                case TransactionType.adjust.rawValue: return partial + row.amount
                default: return partial
                }
            }
            return balance
        }
    }

    func record(transaction: WalletTransaction, _ db: Database) throws {
        let row = WalletRow(id: transaction.id.uuidString, ts: transaction.ts, type: transaction.type.rawValue, amount: transaction.amount, meta: try String(data: JSONEncoder().encode(transaction.meta), encoding: .utf8), syncId: transaction.syncId, deviceId: DeviceIdentity.shared.id)
        try row.insert(db)
    }
}
