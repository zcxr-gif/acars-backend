import Foundation

@MainActor
final class SearchViewModel: ObservableObject {
    enum Scope: String, CaseIterable, Identifiable {
        case callsign = "Callsign"
        case username = "Pilot"
        case airport = "Airport"
        var id: String { rawValue }
    }

    @Published var query: String = ""
    @Published var scope: Scope = .callsign
    @Published var results: [Flight] = []
    @Published var airportResult: Airport?
    @Published var errorMessage: String?
    @Published var isSearching: Bool = false

    let server: AppConfig.Server
    private let api: APIClient
    private let liveService: LiveFlightsService

    init(server: AppConfig.Server,
         api: APIClient = .shared,
         liveService: LiveFlightsService = .shared) {
        self.server = server
        self.api = api
        self.liveService = liveService
    }

    func search() async {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else {
            results = []
            airportResult = nil
            return
        }
        isSearching = true
        defer { isSearching = false }
        errorMessage = nil

        do {
            switch scope {
            case .airport:
                airportResult = try await api.fetchAirport(icao: term)
                results = []
            case .callsign, .username:
                let sessionId = try await liveService.sessionId(for: server)
                let response = try await api.fetchFlights(sessionId: sessionId)
                results = filterFlights(response.flights, term: term, scope: scope)
                airportResult = nil
            }
        } catch {
            errorMessage = error.localizedDescription
            results = []
            airportResult = nil
        }
    }

    private func filterFlights(_ flights: [Flight], term: String, scope: Scope) -> [Flight] {
        let needle = term.uppercased()
        return flights.filter {
            switch scope {
            case .callsign:
                return $0.callsign.uppercased().contains(needle)
            case .username:
                return ($0.username ?? "").uppercased().contains(needle)
            case .airport:
                return false
            }
        }
    }
}
