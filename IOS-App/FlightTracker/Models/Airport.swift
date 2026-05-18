import Foundation
import CoreLocation

struct Airport: Codable, Hashable {
    let icao: String?
    let iata: String?
    let name: String?
    let city: String?
    let country: String?
    let latitude: Double?
    let longitude: Double?
    let elevation: Double?

    var coordinate: CLLocationCoordinate2D? {
        guard let lat = latitude, let lon = longitude else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}

struct AirportResponse: Codable {
    let ok: Bool
    let icao: String?
    let airport: Airport
}

struct AirportStatus: Codable, Hashable {
    let airportName: String?
    let inboundFlightsCount: Int?
    let outboundFlightsCount: Int?
    let inboundFlights: [String]?
    let outboundFlights: [String]?
    let atcFacilities: [ATCFacility]?
}

struct AirportStatusResponse: Codable {
    let ok: Bool
    let sessionId: String
    let icao: String
    let status: AirportStatus
}

struct AtisResponse: Codable {
    let ok: Bool
    let sessionId: String
    let icao: String
    let atis: String?
}

struct WorldAirport: Codable, Hashable, Identifiable {
    let airportIcao: String?
    let airportName: String?
    let inboundFlightsCount: Int?
    let outboundFlightsCount: Int?

    var id: String { airportIcao ?? UUID().uuidString }
}

struct WorldResponse: Codable {
    let ok: Bool
    let count: Int?
    let world: [WorldAirport]
}
