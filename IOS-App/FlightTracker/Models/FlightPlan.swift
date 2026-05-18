import Foundation
import CoreLocation

struct FlightPlanWaypoint: Codable, Hashable, Identifiable {
    let name: String?
    let type: Int?
    let latitude: Double?
    let longitude: Double?
    let altitude: Double?

    var id: String { (name ?? "wp") + "-\(latitude ?? 0)-\(longitude ?? 0)" }

    var coordinate: CLLocationCoordinate2D? {
        guard let lat = latitude, let lon = longitude else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}

struct FlightPlan: Codable, Hashable {
    let flightPlanId: String?
    let flightId: String?
    let waypoints: [FlightPlanWaypoint]?
    let flightPlanItems: [RawWaypointItem]?

    struct RawWaypointItem: Codable, Hashable {
        let name: String?
        let type: Int?
        let location: Location?
        let altitude: Double?
        let children: [RawWaypointItem]?

        struct Location: Codable, Hashable {
            let latitude: Double?
            let longitude: Double?
        }
    }
}

struct FlightPlanResponse: Codable {
    let ok: Bool
    let flightId: String?
    let plan: FlightPlan?
}
