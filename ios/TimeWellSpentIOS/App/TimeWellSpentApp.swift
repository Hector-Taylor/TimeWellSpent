import SwiftUI
import FamilyControls
import ManagedSettings
import DeviceActivity

@main
struct TimeWellSpentApp: App {
    @StateObject private var appState = AppState()

    init() {
        AppBootstrap.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
        }
    }
}

final class AppBootstrap {
    static let shared = AppBootstrap()
    private let shielding = ShieldingService.shared
    private let notifications = NotificationService.shared

    private init() {}

    func start() {
        shielding.start()
        notifications.registerCategories()
    }
}

final class AppState: ObservableObject {
    @Published var walletBalance: Int = 50
    @Published var screenTimeAuthorized: Bool = false
    @Published var supabaseAuthenticated: Bool = false
    @Published var lastSyncAt: Date? = nil

    private let wallet = WalletService.shared
    private let syncService = SyncCoordinator.shared
    private let familyControls = FamilyControlsService.shared

    init() {
        Task { await refresh() }
    }

    @MainActor
    func refresh() async {
        screenTimeAuthorized = await familyControls.authorizationStatus
        walletBalance = await wallet.currentBalance()
        supabaseAuthenticated = await syncService.isSignedIn
        lastSyncAt = syncService.lastSyncAt
    }

    @MainActor
    func syncNow() async {
        await syncService.syncNow()
        await refresh()
    }
}
