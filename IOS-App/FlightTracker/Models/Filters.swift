import Foundation
import SwiftUI

struct FlightFilters: Equatable {
    var minAltitude: Double = 0
    var maxAltitude: Double = 45_000
    var minSpeed: Double = 0
    var includeOnGround: Bool = true
    var includeAirborne: Bool = true
    var vaOnly: Bool = false
    var staffOnly: Bool = false
    var connectedOnly: Bool = false
    var aircraftIds: Set<String> = []
    var departureIcao: String = ""
    var arrivalIcao: String = ""

    static let `default` = FlightFilters()

    var isActive: Bool {
        self != .default
    }

    var activeCount: Int {
        var n = 0
        if minAltitude > 0 || maxAltitude < 45_000 { n += 1 }
        if minSpeed > 0 { n += 1 }
        if !includeOnGround || !includeAirborne { n += 1 }
        if vaOnly { n += 1 }
        if staffOnly { n += 1 }
        if connectedOnly { n += 1 }
        if !aircraftIds.isEmpty { n += 1 }
        if !departureIcao.isEmpty { n += 1 }
        if !arrivalIcao.isEmpty { n += 1 }
        return n
    }

    func matches(_ flight: Flight) -> Bool {
        let alt = flight.position.alt_ft ?? 0
        let gs = flight.position.gs_kt ?? 0
        let onGround = !flight.isAirborne

        if alt < minAltitude || alt > maxAltitude { return false }
        if gs < minSpeed { return false }
        if onGround && !includeOnGround { return false }
        if !onGround && !includeAirborne { return false }
        if vaOnly && !(flight.isVAMember ?? false) { return false }
        if staffOnly && !(flight.isStaff ?? false) { return false }
        if connectedOnly && !(flight.isConnected ?? false) { return false }
        if !aircraftIds.isEmpty, let id = flight.aircraft?.aircraftId, !aircraftIds.contains(id) { return false }
        if !departureIcao.isEmpty, flight.departureIcao?.uppercased() != departureIcao.uppercased() { return false }
        if !arrivalIcao.isEmpty, flight.arrivalIcao?.uppercased() != arrivalIcao.uppercased() { return false }
        return true
    }
}

enum PlaneColoringMode: String, CaseIterable, Identifiable {
    case altitude = "Altitude"
    case phase = "Phase"
    case speed = "Speed"
    case vaStatus = "VA / Staff"

    var id: String { rawValue }

    var explanation: String {
        switch self {
        case .altitude: return "Cool below FL100, warm at cruise"
        case .phase: return "Climb, cruise, descend, ground"
        case .speed: return "Slow → fast"
        case .vaStatus: return "Staff, VA member, public"
        }
    }
}

enum FlightPhase: String {
    case ground
    case climb
    case cruise
    case descent
    case unknown

    static func from(flight: Flight) -> FlightPhase {
        let vs = flight.position.vs_fpm ?? 0
        let gs = flight.position.gs_kt ?? 0
        let alt = flight.position.alt_ft ?? 0
        if alt < 50 || gs < 40 { return .ground }
        if vs > 500 { return .climb }
        if vs < -500 { return .descent }
        return .cruise
    }

    var color: Color {
        switch self {
        case .ground: return .gray
        case .climb: return .green
        case .cruise: return .blue
        case .descent: return .orange
        case .unknown: return .secondary
        }
    }

    var label: String {
        switch self {
        case .ground: return "Ground"
        case .climb: return "Climbing"
        case .cruise: return "Cruising"
        case .descent: return "Descending"
        case .unknown: return "—"
        }
    }
}

enum PlaneColoring {
    static func color(for flight: Flight, mode: PlaneColoringMode) -> Color {
        switch mode {
        case .altitude:
            return altitudeColor(flight.position.alt_ft ?? 0)
        case .phase:
            return FlightPhase.from(flight: flight).color
        case .speed:
            return speedColor(flight.position.gs_kt ?? 0)
        case .vaStatus:
            if flight.isStaff == true { return .yellow }
            if flight.isVAMember == true { return .cyan }
            return .gray
        }
    }

    private static func altitudeColor(_ alt: Double) -> Color {
        // Cool teal at sea level → green → yellow → orange → magenta at FL400+
        let clamped = max(0, min(45_000, alt)) / 45_000
        return Color(
            hue: 0.55 - clamped * 0.7,
            saturation: 0.8,
            brightness: 0.95
        )
    }

    private static func speedColor(_ gs: Double) -> Color {
        let clamped = max(0, min(600, gs)) / 600
        return Color(
            hue: 0.35 - clamped * 0.35,
            saturation: 0.85,
            brightness: 0.95
        )
    }
}
