import Foundation

struct ATCFacility: Codable, Hashable, Identifiable {
    let frequencyId: String?
    let userId: String?
    let username: String?
    let virtualOrganization: String?
    let airportName: String?
    let type: Int?
    let latitude: Double?
    let longitude: Double?

    var id: String { frequencyId ?? UUID().uuidString }

    var facilityKind: Kind {
        Kind(rawValue: type ?? -1) ?? .unknown
    }

    enum Kind: Int, CaseIterable {
        case ground = 0
        case tower = 1
        case unicom = 2
        case clearance = 3
        case approach = 4
        case departure = 5
        case center = 6
        case atis = 7
        case aircraft = 8
        case recorded = 9
        case unknown = -1

        var label: String {
            switch self {
            case .ground: return "Ground"
            case .tower: return "Tower"
            case .unicom: return "Unicom"
            case .clearance: return "Clearance"
            case .approach: return "Approach"
            case .departure: return "Departure"
            case .center: return "Center"
            case .atis: return "ATIS"
            case .aircraft: return "Aircraft"
            case .recorded: return "Recorded"
            case .unknown: return "Unknown"
            }
        }
    }
}

struct ATCResponse: Codable {
    let ok: Bool
    let count: Int?
    let atc: [ATCFacility]
}

struct NotamItem: Codable, Hashable, Identifiable {
    let id: String?
    let title: String?
    let message: String?
    let icao: String?
    let startTime: String?
    let endTime: String?
    let author: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, message, icao, startTime, endTime, author
    }

    var stableId: String { id ?? UUID().uuidString }
}

struct NotamsResponse: Codable {
    let ok: Bool
    let count: Int?
    let notams: [NotamItem]
}
