import Foundation
import CoreLocation

struct Flight: Codable, Identifiable, Hashable {
    let flightId: String
    let userId: String?
    let callsign: String
    let username: String?
    let virtualOrganization: String?
    let arrivalIcao: String?
    let departureIcao: String?
    let isVAMember: Bool?
    let isStaff: Bool?
    let vaRole: String?
    let position: Position
    let aircraft: AircraftInfo?
    let pilotState: Int?
    let isConnected: Bool?

    var id: String { flightId }

    var coordinate: CLLocationCoordinate2D? {
        guard let lat = position.lat, let lon = position.lon else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    var displayName: String {
        if !callsign.isEmpty { return callsign }
        return username ?? "Unknown"
    }

    var isAirborne: Bool {
        (position.alt_ft ?? 0) > 50 && (position.gs_kt ?? 0) > 40
    }

    var pilotStateKind: PilotStateKind {
        PilotStateKind(rawValue: pilotState ?? -1) ?? .unknown
    }

    /// Combined searchable string used by the smart search.
    var searchHaystack: String {
        [
            callsign,
            username ?? "",
            virtualOrganization ?? "",
            departureIcao ?? "",
            arrivalIcao ?? "",
            aircraft?.aircraftName ?? "",
            aircraft?.liveryName ?? ""
        ]
        .joined(separator: " ")
        .uppercased()
    }

    enum PilotStateKind: Int {
        case normal = 0
        case connecting = 1
        case initializing = 2
        case removed = 3
        case unknown = -1

        var label: String {
            switch self {
            case .normal: return "Flying"
            case .connecting: return "Connecting"
            case .initializing: return "Initializing"
            case .removed: return "Removed"
            case .unknown: return "—"
            }
        }

        var systemImage: String {
            switch self {
            case .normal: return "airplane"
            case .connecting: return "wifi"
            case .initializing: return "arrow.triangle.2.circlepath"
            case .removed: return "xmark.octagon"
            case .unknown: return "questionmark.circle"
            }
        }
    }

    struct Position: Codable, Hashable {
        let lat: Double?
        let lon: Double?
        let alt_ft: Double?
        let gs_kt: Double?
        let vs_fpm: Double?
        let heading_deg: Double?
        let lastReport: String?
        let lastReportMs: Double?
    }

    struct AircraftInfo: Codable, Hashable {
        let aircraftId: String?
        let liveryId: String?
        let aircraftName: String?
        let liveryName: String?
    }
}

struct FlightsResponse: Codable {
    let ok: Bool
    let total: Int?
    let count: Int?
    let server: String?
    let sessionId: String?
    let flights: [Flight]
    let timestamp: String?
}
