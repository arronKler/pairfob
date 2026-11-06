import UIKit
import Capacitor

/// Installs the app's own bridges before Capacitor loads the first document.
///
/// `capacitorDidLoad()` runs at the end of `loadView()`, after the WKWebView
/// and its configuration exist, and before `viewDidLoad()` calls
/// `loadWebView()`. A user script added here therefore reaches the page before
/// its own scripts run, which is what the `window.PairfobNotify` port needs.
final class PairfobBridgeViewController: CAPBridgeViewController {
    private static let background = UIColor(red: 10 / 255, green: 12 / 255, blue: 16 / 255, alpha: 1)

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView = webView else { return }
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        PairfobNotify.shared.install(webView: webView, primary: true, viewController: self)
    }
}
