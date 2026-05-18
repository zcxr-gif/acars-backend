import SwiftUI

struct RootView: View {
    @EnvironmentObject private var mapVM: MapViewModel
    @EnvironmentObject private var push: PushNotificationService
    @State private var selectedTab: Tab = .map

    enum Tab: Hashable { case map, search, atc, settings }

    var body: some View {
        TabView(selection: $selectedTab) {
            LiveMapView()
                .tabItem { Label("Live", systemImage: "airplane") }
                .tag(Tab.map)

            NavigationStack {
                SearchView(server: mapVM.selectedServer)
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag(Tab.search)

            NavigationStack {
                ATCListView(server: mapVM.selectedServer)
            }
            .tabItem { Label("ATC", systemImage: "antenna.radiowaves.left.and.right") }
            .tag(Tab.atc)

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
            .tag(Tab.settings)
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var push: PushNotificationService
    @EnvironmentObject private var mapVM: MapViewModel

    var body: some View {
        Form {
            Section("Server") {
                Picker("Active server", selection: Binding(
                    get: { mapVM.selectedServer },
                    set: { mapVM.switchServer($0) }
                )) {
                    ForEach(AppConfig.Server.allCases) { server in
                        Text(server.shortName).tag(server)
                    }
                }
            }

            Section("Notifications") {
                HStack {
                    Text("Authorization")
                    Spacer()
                    Text(authStatusLabel).foregroundStyle(.secondary)
                }
                if push.authorizationStatus == .notDetermined {
                    Button("Enable push notifications") {
                        Task { await push.requestAuthorization() }
                    }
                }
                if let token = push.deviceToken {
                    LabeledContent("Device token") {
                        Text(token.prefix(12) + "…")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("About") {
                LabeledContent("Backend", value: AppConfig.apiBaseURL.host ?? "—")
                LabeledContent("App", value: appVersion)
            }
        }
        .navigationTitle("Settings")
    }

    private var authStatusLabel: String {
        switch push.authorizationStatus {
        case .authorized: return "Authorized"
        case .denied: return "Denied"
        case .ephemeral: return "Ephemeral"
        case .notDetermined: return "Not asked"
        case .provisional: return "Provisional"
        @unknown default: return "Unknown"
        }
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }
}
