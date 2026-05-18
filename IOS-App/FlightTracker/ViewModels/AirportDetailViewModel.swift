import Foundation

@MainActor
final class AirportDetailViewModel: ObservableObject {
    @Published var airport: Airport?
    @Published var status: AirportStatus?
    @Published var atis: String?
    @Published var errorMessage: String?
    @Published var isLoading: Bool = false

    private let api: APIClient

    init(api: APIClient = .shared) {
        self.api = api
    }

    func load(icao: String, sessionId: String?) async {
        isLoading = true
        defer { isLoading = false }

        do {
            airport = try await api.fetchAirport(icao: icao)
        } catch {
            errorMessage = error.localizedDescription
        }

        guard let sessionId else { return }
        status = (try? await api.fetchAirportStatus(sessionId: sessionId, icao: icao))
        atis = (try? await api.fetchAtis(sessionId: sessionId, icao: icao)) ?? nil
    }
}
