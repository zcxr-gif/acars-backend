import SwiftUI

struct HotspotsView: View {
    let server: AppConfig.Server

    @State private var world: [WorldAirport] = []
    @State private var errorMessage: String?
    @State private var isLoading: Bool = false
    @State private var sortMode: SortMode = .total

    enum SortMode: String, CaseIterable, Identifiable {
        case total = "Total"
        case inbound = "Inbound"
        case outbound = "Outbound"
        var id: String { rawValue }
    }

    var sorted: [WorldAirport] {
        let items = world
        switch sortMode {
        case .total:
            return items.sorted {
                ($0.inboundFlightsCount ?? 0) + ($0.outboundFlightsCount ?? 0) >
                ($1.inboundFlightsCount ?? 0) + ($1.outboundFlightsCount ?? 0)
            }
        case .inbound:
            return items.sorted { ($0.inboundFlightsCount ?? 0) > ($1.inboundFlightsCount ?? 0) }
        case .outbound:
            return items.sorted { ($0.outboundFlightsCount ?? 0) > ($1.outboundFlightsCount ?? 0) }
        }
    }

    var body: some View {
        List {
            Picker("Sort by", selection: $sortMode) {
                ForEach(SortMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)

            if isLoading {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let err = errorMessage {
                Text(err).foregroundStyle(.red).font(.caption)
            }

            ForEach(sorted.prefix(50)) { airport in
                NavigationLink {
                    AirportDetailView(icao: airport.airportIcao ?? "", server: server)
                } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading) {
                            Text(airport.airportIcao ?? "—").font(.headline.monospaced())
                            if let name = airport.airportName {
                                Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Label("\(airport.inboundFlightsCount ?? 0)", systemImage: "airplane.arrival")
                                .font(.caption.monospaced())
                            Label("\(airport.outboundFlightsCount ?? 0)", systemImage: "airplane.departure")
                                .font(.caption.monospaced())
                        }
                    }
                }
            }
        }
        .navigationTitle("Hotspots")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let sessionId = try await LiveFlightsService.shared.sessionId(for: server)
            world = try await APIClient.shared.fetchWorld(sessionId: sessionId)
                .filter { ($0.inboundFlightsCount ?? 0) + ($0.outboundFlightsCount ?? 0) > 0 }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
