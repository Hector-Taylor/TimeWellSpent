import Foundation
import FamilyControls
import ManagedSettings

final class FamilyControlsService {
    static let shared = FamilyControlsService()

    private let store = ManagedSettingsStore()
    private let selectionKey = "twsp.selection"

    private init() {
        loadSelection()
    }

    private(set) var selection = FamilyActivitySelection()

    var currentTargets: [FrivolityTarget] {
        let tokens = selection.applicationTokens.map { $0 }
        let domainTokens = selection.webDomainTokens.map { $0 }
        let mapped = tokens.map { token in
            FrivolityTarget(id: token.hashValue.description, kind: .appToken, tokenData: token.dataRepresentation, displayName: token.localizedDisplayName ?? "App")
        } + domainTokens.map { token in
            FrivolityTarget(id: token.hashValue.description, kind: .webDomainToken, tokenData: token.dataRepresentation, displayName: token.localizedDisplayName ?? token.domain)
        }
        return mapped
    }

    var authorizationStatus: Bool {
        get async {
            do {
                return try await AuthorizationCenter.shared.authorizationStatus == .approved
            } catch { return false }
        }
    }

    func requestAuthorization() async -> Bool {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            return true
        } catch {
            return false
        }
    }

    func saveSelection(_ newSelection: FamilyActivitySelection) async {
        selection = newSelection
        if let data = try? JSONEncoder().encode(selection) {
            AppGroupContainer.sharedDefaults.set(data, forKey: selectionKey)
        }
        applyDefaultShielding()
    }

    private func loadSelection() {
        guard let data = AppGroupContainer.sharedDefaults.data(forKey: selectionKey) else { return }
        if let decoded = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data) {
            selection = decoded
        }
    }

    func applyDefaultShielding() {
        // Shield all selected tokens by default
        store.shield.applications = selection.applicationTokens
        store.shield.webDomains = selection.webDomainTokens
    }
}
