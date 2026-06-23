import SwiftUI

struct RootView: View {
    @EnvironmentObject private var mapVM: MapViewModel
    @EnvironmentObject private var push: PushNotificationService
    @State private var selectedTab: Tab = .map

    enum Tab: Hashable { case map, search, atc, hotspots, more }

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
                HotspotsView(server: mapVM.selectedServer)
            }
            .tabItem { Label("Hotspots", systemImage: "flame") }
            .tag(Tab.hotspots)

            NavigationStack {
                MoreView()
            }
            .tabItem { Label("More", systemImage: "ellipsis.circle") }
            .tag(Tab.more)
        }
    }
}

struct MoreView: View {
    @EnvironmentObject private var push: PushNotificationService
    @EnvironmentObject private var mapVM: MapViewModel

    var body: some View {
        List {
            Section("Browse") {
                NavigationLink {
                    NotamsView(server: mapVM.selectedServer)
                } label: {
                    Label("NOTAMs", systemImage: "exclamationmark.bubble")
                }
            }

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

            Section("Map") {
                Picker("Color planes by", selection: $mapVM.coloringMode) {
                    ForEach(PlaneColoringMode.allCases) { Text($0.rawValue).tag($0) }
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
        .navigationTitle("More")
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
