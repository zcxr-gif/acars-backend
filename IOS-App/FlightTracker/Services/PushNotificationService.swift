import Foundation
import UIKit
import UserNotifications

/// Handles APNs registration and forwards the device token to the backend.
///
/// Server contract:
///   POST /api/push/register
///   { "deviceToken": "<hex>", "platform": "ios", "appVersion": "x.y.z" }
///
/// Implement that endpoint in `live_flights.cjs` to persist the token alongside
/// any user identity you want notifications to follow.
final class PushNotificationService: NSObject, ObservableObject {
    static let shared = PushNotificationService()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var deviceToken: String?

    private let api: APIClient

    init(api: APIClient = .shared) {
        self.api = api
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func bootstrap() {
        Task { await refreshAuthorization() }
    }

    func requestAuthorization() async {
        let granted = (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        await refreshAuthorization()
        if granted {
            await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func handle(deviceToken raw: Data) {
        let token = raw.map { String(format: "%02x", $0) }.joined()
        self.deviceToken = token
        Task { await register(token: token) }
    }

    func handle(registrationError: Error) {
        print("APNs registration failed:", registrationError.localizedDescription)
    }

    // MARK: -

    private func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        await MainActor.run { self.authorizationStatus = settings.authorizationStatus }
    }

    private func register(token: String) async {
        struct Payload: Encodable {
            let deviceToken: String
            let platform: String
            let appVersion: String?
        }
        let payload = Payload(
            deviceToken: token,
            platform: "ios",
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        )
        struct Reply: Decodable { let ok: Bool? }
        do {
            let _: Reply = try await api.post(AppConfig.pushRegisterPath, body: payload)
        } catch {
            print("Push registration failed:", error.localizedDescription)
        }
    }
}

extension PushNotificationService: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }
}
