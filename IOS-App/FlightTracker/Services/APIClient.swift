import Foundation

enum APIError: LocalizedError {
    case badURL
    case http(Int, String)
    case decoding(Error)
    case transport(Error)
    case notOk(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "Bad URL"
        case .http(let code, let body): return "HTTP \(code): \(body)"
        case .decoding(let err): return "Decoding failed: \(err.localizedDescription)"
        case .transport(let err): return err.localizedDescription
        case .notOk(let msg): return msg
        }
    }
}

actor APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let baseURL: URL

    init(baseURL: URL = AppConfig.apiBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        self.decoder = JSONDecoder()
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:], as: T.Type = T.self) async throws -> T {
        let url = try buildURL(path: path, query: query)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await perform(req)
    }

    func post<Body: Encodable, T: Decodable>(_ path: String, body: Body, as: T.Type = T.self) async throws -> T {
        let url = try buildURL(path: path, query: [:])
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONEncoder().encode(body)
        return try await perform(req)
    }

    // MARK: -

    private func buildURL(path: String, query: [String: String]) throws -> URL {
        guard var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIError.badURL
        }
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps.url else { throw APIError.badURL }
        return url
    }

    private func perform<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(http.statusCode, body)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}

// MARK: - Typed endpoints

extension APIClient {
    func fetchSessions() async throws -> [IFSession] {
        let res: SessionsResponse = try await get("/if-sessions")
        guard res.ok else { throw APIError.notOk("sessions endpoint returned ok=false") }
        return res.sessions
    }

    func fetchFlights(sessionId: String) async throws -> FlightsResponse {
        try await get("/flights/\(sessionId)")
    }

    func fetchFlightPlan(sessionId: String, flightId: String) async throws -> FlightPlan? {
        let res: FlightPlanResponse = try await get("/flights/\(sessionId)/\(flightId)/plan")
        return res.plan
    }

    func fetchFlightRoute(sessionId: String, flightId: String) async throws -> [FlightRoutePoint] {
        let res: FlightRouteResponse = try await get("/flights/\(sessionId)/\(flightId)/route")
        return res.route
    }

    func fetchFlightHistory(flightId: String) async throws -> [HistoryPoint] {
        let res: FlightHistoryResponse = try await get("/api/flights/\(flightId)/history")
        return res.path
    }

    func fetchATC(sessionId: String) async throws -> [ATCFacility] {
        let res: ATCResponse = try await get("/atc/\(sessionId)")
        return res.atc
    }

    func fetchNotams(sessionId: String) async throws -> [NotamItem] {
        let res: NotamsResponse = try await get("/notams/\(sessionId)")
        return res.notams
    }

    func fetchWorld(sessionId: String) async throws -> [WorldAirport] {
        let res: WorldResponse = try await get("/api/live/world/\(sessionId)")
        return res.world
    }

    func fetchAirport(icao: String) async throws -> Airport {
        let res: AirportResponse = try await get("/api/airport/\(icao.uppercased())")
        return res.airport
    }

    func fetchAirportStatus(sessionId: String, icao: String) async throws -> AirportStatus {
        let res: AirportStatusResponse = try await get("/api/live/airport/\(sessionId)/\(icao.uppercased())/status")
        return res.status
    }

    func fetchAtis(sessionId: String, icao: String) async throws -> String? {
        let res: AtisResponse = try await get("/api/live/airport/\(sessionId)/\(icao.uppercased())/atis")
        return res.atis
    }
}
