import Foundation
import FamilyControls

public enum TargetKind: String, Codable { case appToken; case webDomainToken }

public struct FrivolityTarget: Codable, Identifiable, Hashable {
    public let id: String
    public let kind: TargetKind
    public let tokenData: Data
    public let displayName: String

    public init(id: String, kind: TargetKind, tokenData: Data, displayName: String) {
        self.id = id
        self.kind = kind
        self.tokenData = tokenData
        self.displayName = displayName
    }

    public var token: ActivityCategoryToken? {
        switch kind {
        case .appToken:
            return try? ActivityCategoryToken(dataRepresentation: tokenData)
        case .webDomainToken:
            return try? ActivityCategoryToken(dataRepresentation: tokenData)
        }
    }
}

public struct ShieldedTarget: Codable, Identifiable, Hashable {
    public var id: String { target.id }
    public let target: FrivolityTarget
    public var isUnshieldedUntil: Date?
}
