import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        // Inject real safe-area insets as CSS variables into the WKWebView,
        // because env(safe-area-inset-top) returns 0 in Capacitor's default layout.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            self.injectSafeAreaInsets()
        }
    }

    // MARK: - Safe Area Injection

    private func injectSafeAreaInsets() {
        guard let rootVC = window?.rootViewController else { return }
        let windowInsets = rootVC.view.window?.safeAreaInsets ?? .zero
        let top = max(rootVC.view.safeAreaInsets.top, windowInsets.top)
        let bottom = max(rootVC.view.safeAreaInsets.bottom, windowInsets.bottom)
        guard top > 0 else { return }

        let js = """
        (function() {
          var r = document.documentElement;
          r.style.setProperty('--sat', '\(top)px');
          r.style.setProperty('--sab', '\(bottom)px');
        })();
        """

        for webView in findWebViews(in: rootVC.view) {
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func findWebViews(in view: UIView) -> [WKWebView] {
        var result: [WKWebView] = []
        if let wk = view as? WKWebView { result.append(wk) }
        for sub in view.subviews { result.append(contentsOf: findWebViews(in: sub)) }
        return result
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
