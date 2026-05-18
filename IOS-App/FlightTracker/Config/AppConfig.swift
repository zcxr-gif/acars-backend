import Foundation

enum AppConfig {
    static let apiBaseURL: URL = {
        if let override = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String,
           let url = URL(string: override) {
            return url
        }
        return URL(string: "https://site--acars-backend--6dmjph8ltlhv.code.run")!
    }()

    static let liveFlightsPollInterval: TimeInterval = 4.0
    static let secondaryDataPollInterval: TimeInterval = 30.0

    static let pushRegisterPath = "/api/push/register"

    enum Server: String, CaseIterable, Identifiable, Hashable {
        case expert = "Expert Server"
        case training = "Training Server"
        case casual = "Casual Server"

        var id: String { rawValue }
        var shortName: String {
            switch self {
            case .expert: return "Expert"
            case .training: return "Training"
            case .casual: return "Casual"
            }
        }
    }
}
