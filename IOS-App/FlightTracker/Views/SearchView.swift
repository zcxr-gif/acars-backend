import SwiftUI

struct SearchView: View {
    let server: AppConfig.Server
    @StateObject private var vm: SearchViewModel

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
                ProgressView().frame(maxWidth: .infinity)
            }

            if let err = vm.errorMessage {
                Text(err).foregroundStyle(.red).font(.caption)
            }

            if let airport = vm.airportResult {
                Section("Airport") {
                    NavigationLink {
                        AirportDetailView(icao: airport.icao ?? vm.query.uppercased(), server: server)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(airport.name ?? airport.icao ?? "Airport")
                                .font(.headline)
                            Text("\(airport.city ?? "") \(airport.country ?? "")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if !vm.results.isEmpty {
                Section("Flights") {
                    ForEach(vm.results) { flight in
                        NavigationLink {
                            FlightDetailView(flight: flight, server: server)
                        } label: {
                            FlightRow(flight: flight)
                        }
                    }
                }
            }
        }
        .navigationTitle("Search")
        .searchable(text: $vm.query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: prompt)
        .onChange(of: vm.query) { _, _ in
            Task { await vm.search() }
        }
        .onChange(of: vm.scope) { _, _ in
            Task { await vm.search() }
        }
    }

    private var prompt: String {
        switch vm.scope {
        case .callsign: return "Callsign (e.g. AAL123)"
        case .username: return "Pilot name"
        case .airport: return "Airport ICAO (e.g. KLAX)"
        }
    }
}

private struct FlightRow: View {
    let flight: Flight

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(flight.callsign).font(.headline)
                if let user = flight.username {
                    Text(user).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let dep = flight.departureIcao, let arr = flight.arrivalIcao {
                Text("\(dep) → \(arr)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
    }
}
