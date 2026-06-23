import SwiftUI

struct SearchView: View {
    let server: AppConfig.Server
    @StateObject private var vm: SearchViewModel
    @State private var refreshTask: Task<Void, Never>?

    init(server: AppConfig.Server) {
        self.server = server
        _vm = StateObject(wrappedValue: SearchViewModel(server: server))
    }

    var body: some View {
        List {
            Picker("Scope", selection: $vm.scope) {
                ForEach(SearchViewModel.Scope.allCases) { scope in
                    Text(scope.rawValue).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)

            if vm.isSearching {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }

            if vm.query.isEmpty {
                emptyStateSections
            } else {
                if !vm.suggestions.isEmpty {
                    Section("Suggestions") {
                        ForEach(vm.suggestions, id: \.self) { suggestion in
                            Button {
                                vm.query = suggestion
                                vm.commitRecent()
                                Task { await vm.resolveAirportIfICAO() }
                            } label: {
                                HStack {
                                    Image(systemName: "sparkle.magnifyingglass")
                                        .foregroundStyle(.secondary)
                                    Text(suggestion)
                                    Spacer()
                                    Image(systemName: "arrow.up.left")
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .tint(.primary)
                        }
                    }
                }

                if let err = vm.errorMessage {
                    Section { Text(err).foregroundStyle(.red).font(.caption) }
                }

                if let airport = vm.airportResult {
                    Section("Airport") {
                        NavigationLink {
                            AirportDetailView(icao: airport.icao ?? vm.query.uppercased(), server: server)
                        } label: {
                            VStack(alignment: .leading) {
                                Text(airport.name ?? airport.icao ?? "Airport").font(.headline)
                                HStack {
                                    if let icao = airport.icao {
                                        Text(icao).font(.caption.monospaced())
                                    }
                                    if let city = airport.city {
                                        Text(city).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }

                let matches = vm.matchingFlights
                if !matches.isEmpty {
                    Section("Flights (\(matches.count))") {
                        ForEach(matches) { flight in
                            NavigationLink {
                                FlightDetailView(flight: flight, server: server)
                            } label: {
                                SmartFlightRow(flight: flight)
                            }
                        }
                    }
                } else if !vm.query.isEmpty && vm.airportResult == nil {
                    Section { Text("No matches").foregroundStyle(.secondary) }
                }
            }
        }
        .navigationTitle("Search")
        .searchable(text: $vm.query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: prompt)
        .onChange(of: vm.query) { _, _ in
            refreshTask?.cancel()
            refreshTask = Task {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if !Task.isCancelled { await vm.resolveAirportIfICAO() }
            }
        }
        .onSubmit(of: .search) {
            vm.commitRecent()
        }
        .task {
            await vm.refreshSnapshot()
        }
        .refreshable {
            await vm.refreshSnapshot()
        }
    }

    @ViewBuilder
    private var emptyStateSections: some View {
        if !vm.recents.isEmpty {
            Section {
                ForEach(vm.recents, id: \.self) { term in
                    Button {
                        vm.query = term
                        Task { await vm.resolveAirportIfICAO() }
                    } label: {
                        HStack {
                            Image(systemName: "clock.arrow.circlepath")
                                .foregroundStyle(.secondary)
                            Text(term)
                            Spacer()
                        }
                    }
                    .tint(.primary)
                }
            } header: {
                HStack {
                    Text("Recent")
                    Spacer()
                    Button("Clear") { vm.clearRecents() }
                        .font(.caption)
                }
            }
        }

        Section("Popular") {
            ForEach(["KLAX", "EGLL", "OMDB", "VHHH", "KJFK"], id: \.self) { icao in
                NavigationLink {
                    AirportDetailView(icao: icao, server: server)
                } label: {
                    HStack {
                        Image(systemName: "airplane.arrival").foregroundStyle(.secondary)
                        Text(icao).font(.body.monospaced())
                    }
                }
            }
        }
    }

    private var prompt: String {
        switch vm.scope {
        case .all: return "Callsign, pilot, ICAO, aircraft, VA…"
        case .callsign: return "Callsign (e.g. AAL123)"
        case .pilot: return "Pilot name"
        case .airport: return "ICAO (e.g. KLAX)"
        case .aircraft: return "Aircraft or livery"
        case .va: return "Virtual organization"
        }
    }
}

struct SmartFlightRow: View {
    let flight: Flight

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: flight.pilotStateKind.systemImage)
                    .foregroundStyle(.tint)
                Text(flight.callsign).font(.headline)
                if flight.isStaff == true {
                    Text("STAFF").badgeStyle(.yellow)
                } else if flight.isVAMember == true, let va = flight.virtualOrganization {
                    Text(va).badgeStyle(.cyan)
                }
                Spacer()
                if let dep = flight.departureIcao, let arr = flight.arrivalIcao {
                    Text("\(dep) → \(arr)")
                        .font(.caption.monospaced().bold())
                        .foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 12) {
                if let user = flight.username {
                    Label(user, systemImage: "person").font(.caption)
                }
                if let ac = flight.aircraft?.aircraftName {
                    Label(ac, systemImage: "airplane").font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 12) {
                if let alt = flight.position.alt_ft, alt > 0 {
                    Label("\(Int(alt)) ft", systemImage: "arrow.up.right").font(.caption2).foregroundStyle(.secondary)
                }
                if let gs = flight.position.gs_kt {
                    Label("\(Int(gs)) kt", systemImage: "speedometer").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private extension Text {
    func badgeStyle(_ color: Color) -> some View {
        self.font(.caption2.bold())
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.2), in: Capsule())
            .foregroundStyle(color)
    }
}
