import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Set the delegate before launch finishes so a notification that
        // cold-starts the app is delivered instead of dropped, and register the
        // background refresh identifier before the scheduler can run it.
        UNUserNotificationCenter.current().delegate = PairfobNotify.shared
        PairfobNotify.registerBackgroundRefresh()
        // A reboot or app update can drop the pending request while the
        // stored choice stays on; restore it before anything can read the
        // status.
        if UserDefaults.standard.bool(forKey: PairfobNotify.syncKey) {
            try? PairfobNotify.scheduleRefresh()
        }
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(
            name: "Default Configuration",
            sessionRole: connectingSceneSession.role
        )
        config.delegateClass = SceneDelegate.self
        return config
    }
}
