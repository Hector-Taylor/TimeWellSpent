import SwiftUI

struct ContentView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Dashboard", systemImage: "speedometer") }
            TargetsView()
                .tabItem { Label("Targets", systemImage: "shield.lefthalf.filled") }
            MarketView()
                .tabItem { Label("Market", systemImage: "cart") }
            FriendsView()
                .tabItem { Label("Friends", systemImage: "person.2.fill") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

struct DashboardView: View {
    @EnvironmentObject var appState: AppState
    @State private var activeSessions: [PaywallSession] = []

    var body: some View {
        NavigationStack {
            List {
                Section(header: Text("Wallet")) {
                    HStack {
                        Text("Balance")
                        Spacer()
                        Text("\(appState.walletBalance) coins").bold()
                    }
                    if let lastSync = appState.lastSyncAt {
                        Text("Last sync: \(RelativeDateTimeFormatter().string(from: lastSync, to: Date()))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Never synced").font(.footnote).foregroundStyle(.secondary)
                    }
                }

                Section(header: Text("Active Sessions")) {
                    if activeSessions.isEmpty {
                        Text("No active packs").foregroundStyle(.secondary)
                    }
                    ForEach(activeSessions) { session in
                        VStack(alignment: .leading) {
                            Text(session.targetName).bold()
                            Text("Remaining: \(session.remainingSeconds / 60)m")
                                .font(.subheadline)
                        }
                    }
                }
            }
            .navigationTitle("TimeWellSpent")
            .task { activeSessions = await PaywallService.shared.activeSessions() }
        }
    }
}

struct TargetsView: View {
    @State private var targets: [FrivolityTarget] = []
    @State private var isPickerPresented = false
    private let familyControls = FamilyControlsService.shared

    var body: some View {
        NavigationStack {
            List {
                ForEach(targets) { target in
                    Text(target.displayName)
                }
            }
            .navigationTitle("Targets")
            .toolbar {
                Button { isPickerPresented = true } label { Image(systemName: "plus") }
            }
            .familyActivityPicker(isPresented: $isPickerPresented, selection: Binding(get: {
                familyControls.selection
            }, set: { newValue in
                Task { await familyControls.saveSelection(newValue) }
                targets = familyControls.currentTargets
            }))
            .task { targets = familyControls.currentTargets }
        }
    }
}

struct MarketView: View {
    @State private var rates: [MarketRate] = []
    var body: some View {
        NavigationStack {
            List {
                ForEach(rates) { rate in
                    VStack(alignment: .leading) {
                        Text(rate.targetId).bold()
                        Text("Rate: \(rate.ratePerMin)/min")
                    }
                }
            }
            .navigationTitle("Market")
            .task { rates = await MarketService.shared.listRates() }
        }
    }
}

struct FriendsView: View {
    @State private var friends: [FriendConnection] = []
    var body: some View {
        NavigationStack {
            List(friends, id: \.id) { friend in
                Text(friend.displayName ?? friend.handle ?? "Friend")
            }
            .navigationTitle("Friends")
            .task { friends = await FriendsService.shared.list() }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @State private var syncing = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(header: Text("Screen Time")) {
                    HStack {
                        Text("Authorized")
                        Spacer()
                        Image(systemName: appState.screenTimeAuthorized ? "checkmark.seal.fill" : "exclamationmark.triangle")
                            .foregroundStyle(appState.screenTimeAuthorized ? .green : .yellow)
                    }
                    Button("Request Access") {
                        Task { appState.screenTimeAuthorized = await FamilyControlsService.shared.requestAuthorization() }
                    }
                }

                Section(header: Text("Supabase"), footer: Text(error ?? "")) {
                    HStack {
                        Text("Signed in")
                        Spacer()
                        Image(systemName: appState.supabaseAuthenticated ? "checkmark.circle.fill" : "person.crop.circle.badge.questionmark")
                    }
                    Button("Sign In (PKCE)") {
                        Task { error = await SyncCoordinator.shared.signIn() }
                    }
                    Button("Sign Out") { Task { await SyncCoordinator.shared.signOut() } }
                    Button(syncing ? "Syncing…" : "Sync Now") {
                        Task {
                            syncing = true
                            await appState.syncNow()
                            syncing = false
                        }
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }
}
