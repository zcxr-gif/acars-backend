import Foundation

struct UserStats: Codable, Hashable {
    let virtualOrganization: String?
    let discourseUsername: String?
    let groups: [String]?
    let roles: [String]?
    let gradeDetails: GradeDetails?
    let calculatedGrade: Int?
    let violationCountByLevel: [String: Int]?
    let totalXP: Double?
    let atcOperations: Int?
    let atcRank: Int?
    let total12MonthsViolations: Int?
    let lastLevel1ViolationDate: String?
    let lastLevel2ViolationDate: String?
    let lastLevel3ViolationDate: String?
    let lastReportViolationDate: String?
    let flightTime: Double?
    let landingCount: Int?
    let onlineFlights: Int?
    let violations: Int?

    var flightTimeFormatted: String? {
        guard let mins = flightTime else { return nil }
        let h = Int(mins) / 60
        let m = Int(mins) % 60
        return String(format: "%dh %02dm", h, m)
    }

    var atcRankLabel: String? {
        guard let rank = atcRank else { return nil }
        let labels = ["Observer", "Trainee", "Apprentice", "Specialist", "Officer", "Supervisor"]
        return rank >= 0 && rank < labels.count ? labels[rank] : "Rank \(rank)"
    }
}

struct GradeDetails: Codable, Hashable {
    let gradeIndex: Int?
    let nextGradeIndex: Int?
    let stateTimeOut: String?
    let isReinforcedRules: Bool?
}

struct UserStatsResponse: Codable {
    let ok: Bool
    let userId: String
    let stats: UserStats
}

/// Response from POST /users (one entry per requested id).
struct BulkUserStat: Codable, Hashable {
    let userId: String?
    let virtualOrganization: String?
    let discourseUsername: String?
    let flightTime: Double?
    let landingCount: Int?
    let onlineFlights: Int?
    let violations: Int?
    let totalXP: Double?
    let atcRank: Int?
    let roles: [String]?
}

struct BulkUserStatsResponse: Codable {
    let ok: Bool
    let count: Int?
    let users: [BulkUserStat]
}
