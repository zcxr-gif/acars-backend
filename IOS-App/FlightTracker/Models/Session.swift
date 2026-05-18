import Foundation

struct IFSession: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let maxUsers: Int?
    let userCount: Int?
    let type: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, maxUsers, userCount, type
    }
}

struct SessionsResponse: Codable {
    let ok: Bool
    let count: Int?
    let sessions: [IFSession]
}
