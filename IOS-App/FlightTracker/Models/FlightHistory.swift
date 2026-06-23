import Foundation
import CoreLocation

struct HistoryPoint: Codable, Hashable, Identifiable {
    let lat: Double
    let lon: Double
    let alt: Double
    let gs: Double
    let time: Double
    let hdg: Double?

    var id: Double { time }
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
    var date: Date { Date(timeIntervalSince1970: time / 1000) }
}

struct FlightHistoryResponse: Codable {
    let ok: Bool
    let flightId: String
    let path: [HistoryPoint]
}

struct FlightRoutePoint: Codable, Hashable, Identifiable {
    let latitude: Double
    let longitude: Double
    let altitude: Double?
    let groundSpeed: Double?
    let date: String?

    var id: String { "\(latitude),\(longitude),\(date ?? "")" }
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

struct FlightRouteResponse: Codable {
    let ok: Bool
    let flightId: String
    let route: [FlightRoutePoint]
}
