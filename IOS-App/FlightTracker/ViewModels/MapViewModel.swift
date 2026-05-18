import Foundation
import MapKit
import Combine

@MainActor
final class MapViewModel: ObservableObject {
    @Published private(set) var allFlights: [Flight] = []
    @Published var selectedServer: AppConfig.Server = .expert
    @Published var lastUpdated: Date?
    @Published var errorMessage: String?
    @Published var isLoading: Bool = false
    @Published var filters: FlightFilters = .default
    @Published var coloringMode: PlaneColoringMode = .altitude
    @Published var cameraPosition: MapCameraPosition = .region(
        MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 30.0, longitude: 0.0),
            span: MKCoordinateSpan(latitudeDelta: 90.0, longitudeDelta: 180.0)
        )
    )

    var flights: [Flight] {
        allFlights.filter(filters.matches)
    }

    var filteredCount: Int { flights.count }
    var totalCount: Int { allFlights.count }

    private let liveService: LiveFlightsService
    private var streamTask: Task<Void, Never>?

    init(liveService: LiveFlightsService = .shared) {
        self.liveService = liveService
    }

    func start() {
        streamTask?.cancel()
        isLoading = true
        let server = selectedServer
        streamTask = Task { [weak self] in
            guard let self else { return }
            for await event in self.liveService.stream(for: server) {
                if Task.isCancelled { break }
                switch event {
                case .success(let payload):
                    let airborne = payload.flights.filter { $0.coordinate != nil }
                    self.allFlights = airborne
                    self.lastUpdated = Date()
                    self.errorMessage = nil
                    self.isLoading = false
                case .failure(let error):
                    self.errorMessage = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func switchServer(_ server: AppConfig.Server) {
        guard server != selectedServer else { return }
        selectedServer = server
        allFlights = []
        start()
    }

    func focus(on flight: Flight) {
        guard let coord = flight.coordinate else { return }
        cameraPosition = .region(MKCoordinateRegion(
            center: coord,
            span: MKCoordinateSpan(latitudeDelta: 2.5, longitudeDelta: 2.5)
        ))
    }

    func resetFilters() {
        filters = .default
    }
}
