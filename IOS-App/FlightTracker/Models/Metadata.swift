import Foundation

struct AircraftType: Codable, Hashable, Identifiable {
    let id: String
    let name: String
}

struct Livery: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let aircraftId: String?
    let aircraftName: String?
}

struct MetadataResponse: Codable {
    let ok: Bool
    let aircraft: [AircraftType]
    let liveries: [Livery]
}

struct LiveriesResponse: Codable {
    let ok: Bool
    let aircraftId: String
    let count: Int
    let liveries: [Livery]
}
