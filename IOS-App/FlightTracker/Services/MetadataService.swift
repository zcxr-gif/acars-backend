import Foundation

@MainActor
final class MetadataService: ObservableObject {
    static let shared = MetadataService()

    @Published private(set) var aircraft: [AircraftType] = []
    @Published private(set) var liveries: [Livery] = []
    @Published private(set) var loaded = false

    private let api: APIClient

    init(api: APIClient = .shared) {
        self.api = api
    }

    func loadIfNeeded() async {
        guard !loaded else { return }
        do {
            let res = try await api.fetchMetadata()
            aircraft = res.aircraft.sorted(by: { $0.name < $1.name })
            liveries = res.liveries
            loaded = true
        } catch {
            print("MetadataService failed:", error.localizedDescription)
        }
    }

    func aircraftName(id: String?) -> String? {
        guard let id else { return nil }
        return aircraft.first(where: { $0.id == id })?.name
    }
}
