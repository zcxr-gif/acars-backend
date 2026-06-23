import Foundation

@MainActor
final class SearchViewModel: ObservableObject {
    enum Scope: String, CaseIterable, Identifiable {
        case all = "All"
        case callsign = "Callsign"
        case pilot = "Pilot"
        case airport = "Airport"
        case aircraft = "Aircraft"
        case va = "VA"
        var id: String { rawValue }
    }

    @Published var query: String = ""
    @Published var scope: Scope = .all
    @Published var liveSnapshot: [Flight] = []
    @Published var airportResult: Airport?
    @Published var errorMessage: String?
    @Published var isSearching: Bool = false
    @Published private(set) var recents: [String] = []

    let server: AppConfig.Server
    private let api: APIClient
    private let liveService: LiveFlightsService
    private let recentsKey: String

    init(server: AppConfig.Server,
         api: APIClient = .shared,
         liveService: LiveFlightsService = .shared) {
        self.server = server
        self.api = api
        self.liveService = liveService
        self.recentsKey = "search.recents.\(server.rawValue)"
        self.recents = UserDefaults.standard.stringArray(forKey: recentsKey) ?? []
    }

    // MARK: - Public API

    /// Refresh the underlying flight snapshot used for live matching.
    func refreshSnapshot() async {
        do {
            let sessionId = try await liveService.sessionId(for: server)
            let response = try await api.fetchFlights(sessionId: sessionId)
            liveSnapshot = response.flights
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Local result computed from the snapshot — instant filter as user types.
    var matchingFlights: [Flight] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !term.isEmpty else { return [] }
        return liveSnapshot.filter { flight in
            switch scope {
            case .all:
                return flight.searchHaystack.contains(term)
            case .callsign:
                return flight.callsign.uppercased().contains(term)
            case .pilot:
                return (flight.username ?? "").uppercased().contains(term)
            case .airport:
                return false
            case .aircraft:
                let a = (flight.aircraft?.aircraftName ?? "").uppercased()
                let l = (flight.aircraft?.liveryName ?? "").uppercased()
                return a.contains(term) || l.contains(term)
            case .va:
                return (flight.virtualOrganization ?? "").uppercased().contains(term)
            }
        }
        .sorted { $0.callsign < $1.callsign }
    }

    var suggestions: [String] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty, term.count >= 1 else { return [] }
        let upper = term.uppercased()
        var seen = Set<String>()
        var out: [String] = []
        for f in liveSnapshot {
            for candidate in [f.callsign, f.username ?? "", f.aircraft?.aircraftName ?? "", f.virtualOrganization ?? ""] {
                guard !candidate.isEmpty else { continue }
                if candidate.uppercased().contains(upper), seen.insert(candidate.uppercased()).inserted {
                    out.append(candidate)
                }
                if out.count >= 8 { return out }
            }
        }
        return out
    }

    /// Resolve airport when the query looks like an ICAO (3-4 chars).
    func resolveAirportIfICAO() async {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard scope == .all || scope == .airport,
              (3...4).contains(term.count),
              term.allSatisfy({ $0.isLetter || $0.isNumber }) else {
            airportResult = nil
            return
        }
        do {
            airportResult = try await api.fetchAirport(icao: term.uppercased())
        } catch {
            airportResult = nil
        }
    }

    func commitRecent() {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard term.count >= 2 else { return }
        var updated = recents.filter { $0.caseInsensitiveCompare(term) != .orderedSame }
        updated.insert(term, at: 0)
        if updated.count > 10 { updated = Array(updated.prefix(10)) }
        recents = updated
        UserDefaults.standard.set(updated, forKey: recentsKey)
    }

    func clearRecents() {
        recents = []
        UserDefaults.standard.removeObject(forKey: recentsKey)
    }
}
