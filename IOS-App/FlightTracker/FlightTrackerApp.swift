import SwiftUI
import UIKit

@main
struct FlightTrackerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var pushService = PushNotificationService.shared
    @StateObject private var mapViewModel = MapViewModel()
    @StateObject private var metadataService = MetadataService.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(pushService)
                .environmentObject(mapViewModel)
                .environmentObject(metadataService)
                .task {
                    pushService.bootstrap()
                    mapViewModel.start()
                    await metadataService.loadIfNeeded()
                }
                .preferredColorScheme(.dark)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotificationService.shared.handle(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushNotificationService.shared.handle(registrationError: error)
    }
}
