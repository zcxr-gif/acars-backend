import Foundation
import CoreLocation

@MainActor
final class FlightDetailViewModel: ObservableObject {
    @Published var plan: FlightPlan?
    @Published var route: [FlightRoutePoint] = []
    @Published var history: [HistoryPoint] = []
    @Published var errorMessage: String?
    @Published var isLoading: Bool = false

    private let api: APIClient

    init(api: APIClient = .shared) {
        self.api = api
    }

    func load(flight: Flight, sessionId: String) async {
        isLoading = true
        defer { isLoading = false }

        async let planTask: FlightPlan? = (try? await api.fetchFlightPlan(sessionId: sessionId, flightId: flight.flightId))
        async let routeTask: [FlightRoutePoint] = (try? await api.fetchFlightRoute(sessionId: sessionId, flightId: flight.flightId)) ?? []
        async let historyTask: [HistoryPoint] = (try? await api.fetchFlightHistory(flightId: flight.flightId)) ?? []

        plan = await planTask
        route = await routeTask
        history = await historyTask
    }

    var planCoordinates: [CLLocationCoordinate2D] {
        let waypoints = plan?.waypoints ?? []
        return waypoints.compactMap { $0.coordinate }
    }

    var historyCoordinates: [CLLocationCoordinate2D] {
        history.map { $0.coordinate }
    }
}
