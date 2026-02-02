import Foundation
import ManagedSettings
import FamilyControls

final class ShieldingService {
    static let shared = ShieldingService()

    private let store = ManagedSettingsStore()
    private let family = FamilyControlsService.shared

    private init() {}

    func start() {
        // Apply default shields at launch
        family.applyDefaultShielding()
    }

    func showShield(for target: FrivolityTarget) {
        // Could trigger UI in ShieldConfiguration extension; placeholder here
        if let token = target.token {
            switch target.kind {
            case .appToken:
                store.shield.applications?.insert(token)
            case .webDomainToken:
                store.shield.webDomains?.insert(token)
            }
        }
    }
}
