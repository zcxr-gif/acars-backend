import Foundation

/// Streams live flight updates for a chosen Infinite Flight server. The current
/// implementation polls the REST endpoint that the Node backend keeps in cache
/// (refreshed by its socket.io broadcaster). Swap the body of `stream(for:)` for
/// a Socket.IO subscription later without changing call sites.
actor LiveFlightsService {
    static let shared = LiveFlightsService()

    private let api: APIClient
    private let pollInterval: TimeInterval

    init(api: APIClient = .shared, pollInterval: TimeInterval = AppConfig.liveFlightsPollInterval) {
        self.api = api
        self.pollInterval = pollInterval
    }

    /// Resolve the IF session id for a given server name (cached for the actor lifetime).
    private var sessionCache: [AppConfig.Server: String] = [:]

    func sessionId(for server: AppConfig.Server) async throws -> String {
        if let cached = sessionCache[server] { return cached }
        let sessions = try await api.fetchSessions()
        guard let match = sessions.first(where: {
            $0.name.caseInsensitiveCompare(server.rawValue) == .orderedSame
        }) else {
            throw APIError.notOk("Session \(server.rawValue) not found")
        }
        sessionCache[server] = match.id
        return match.id
    }

    nonisolated func stream(for server: AppConfig.Server) -> AsyncStream<Result<FlightsResponse, Error>> {
        AsyncStream { continuation in
            let task = Task {
                while !Task.isCancelled {
                    do {
                        let sessionId = try await self.sessionId(for: server)
                        let response = try await self.api.fetchFlights(sessionId: sessionId)
                        continuation.yield(.success(response))
                    } catch {
                        continuation.yield(.failure(error))
                    }
                    try? await Task.sleep(nanoseconds: UInt64(self.pollInterval * 1_000_000_000))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    nonisolated func atcStream(for server: AppConfig.Server) -> AsyncStream<Result<[ATCFacility], Error>> {
        AsyncStream { continuation in
            let task = Task {
                while !Task.isCancelled {
                    do {
                        let sessionId = try await self.sessionId(for: server)
                        let atc = try await self.api.fetchATC(sessionId: sessionId)
                        continuation.yield(.success(atc))
                    } catch {
                        continuation.yield(.failure(error))
                    }
                    try? await Task.sleep(nanoseconds: UInt64(AppConfig.secondaryDataPollInterval * 1_000_000_000))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
