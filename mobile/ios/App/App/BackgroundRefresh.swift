import BackgroundTasks
import UIKit
import UniformTypeIdentifiers
import WebKit

/// The scheduled half of local notifications. iOS has no periodic job with an
/// Android-style guarantee; `BGAppRefreshTask` is opportunistic and the system
/// decides when (and whether) it runs. The work itself is the same idea as the
/// Android job: load the bundled page offscreen at the app's own origin, let
/// the page's hidden lane reach a status transition, and post through the
/// notification bridge.
extension PairfobNotify {
    /// The system or the user can turn Background App Refresh off for this app,
    /// and the scheduler then accepts a request it will never run. Report that
    /// as a failed schedule instead of promising a wake that cannot happen.
    enum RefreshError: Error {
        case unavailable
    }

    static func registerBackgroundRefresh() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: refreshIdentifier,
            using: nil
        ) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            PairfobRefreshRunner.shared.start(refresh)
        }
    }

    static func scheduleRefresh() throws {
        guard UIApplication.shared.backgroundRefreshStatus == .available else {
            throw RefreshError.unavailable
        }
        // A request with this identifier may already be pending: from an
        // earlier `setBackgroundSync`, or from a launch after a reboot, which
        // drops the schedule while the stored choice stays on. Submitting a
        // second request throws `.tooManyPendingTaskRequests`, so replace it.
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: refreshIdentifier)
        let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try BGTaskScheduler.shared.submit(request)
    }

    static func cancelRefresh() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: refreshIdentifier)
    }
}

/// Runs one background refresh. The task is completed exactly once, on the
/// main queue, whether the page finishes early, the timer expires, or iOS
/// reclaims the time.
final class PairfobRefreshRunner {
    static let shared = PairfobRefreshRunner()

    /// iOS grants roughly thirty seconds. Leave room to tear the page down
    /// before the expiration handler fires.
    private static let holdSeconds: TimeInterval = 24

    private var task: BGAppRefreshTask?
    private var webView: WKWebView?
    private var bridge: PairfobNotify?
    private var timer: Timer?

    func start(_ task: BGAppRefreshTask) {
        DispatchQueue.main.async { self.begin(task) }
    }

    private func begin(_ task: BGAppRefreshTask) {
        // A refresh request is consumed by the run that handles it, so queue
        // the next one before doing any work.
        if UserDefaults.standard.bool(forKey: PairfobNotify.syncKey) {
            try? PairfobNotify.scheduleRefresh()
        }
        guard UserDefaults.standard.bool(forKey: PairfobNotify.syncKey),
              UIApplication.shared.applicationState != .active else {
            task.setTaskCompleted(success: true)
            return
        }
        stop(complete: false)
        self.task = task
        task.expirationHandler = { [weak self] in
            DispatchQueue.main.async { self?.stop(complete: false) }
        }
        guard let root = Bundle.main.url(forResource: "public", withExtension: nil) else {
            stop(complete: true)
            return
        }

        let configuration = WKWebViewConfiguration()
        // The visible app and this page must read the same IndexedDB session.
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(PairfobAssetHandler(root: root), forURLScheme: "capacitor")
        let bridge = PairfobNotify()
        configuration.userContentController.addUserScript(WKUserScript(
            source: PairfobNotify.hiddenScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let view = WKWebView(
            frame: CGRect(x: -2, y: -2, width: 1, height: 1),
            configuration: configuration
        )
        bridge.install(webView: view, primary: false)
        self.bridge = bridge
        self.webView = view
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
           let host = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first {
            // A web view outside a window may have its page lifecycle paused;
            // keep it in the hierarchy, just off the screen.
            host.addSubview(view)
        }
        view.load(URLRequest(url: URL(string: "capacitor://localhost/")!))
        timer = Timer.scheduledTimer(withTimeInterval: Self.holdSeconds, repeats: false) { [weak self] _ in
            self?.stop(complete: true)
        }
    }

    private func stop(complete: Bool) {
        timer?.invalidate()
        timer = nil
        webView?.removeFromSuperview()
        webView = nil
        bridge = nil
        guard let task = task else { return }
        self.task = nil
        task.setTaskCompleted(success: complete)
    }
}

/// Serves the app bundle at `capacitor://localhost`, the same origin the
/// Capacitor web view uses. The offscreen page therefore sees the visible
/// app's local storage and IndexedDB.
final class PairfobAssetHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let path = url.path.removingPercentEncoding ?? url.path
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.contains(where: { $0 == ".." }) else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var relative = parts.joined(separator: "/")
        if relative.isEmpty { relative = "index.html" }

        var file = root.appendingPathComponent(relative)
        if path.hasSuffix("/") { file.appendPathComponent("index.html") }
        if !FileManager.default.fileExists(atPath: file.path),
           (relative as NSString).pathExtension.isEmpty {
            // The app routes in the fragment, but a path such as `/pair` is
            // still the same document.
            file = root.appendingPathComponent("index.html")
        }
        guard let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ]
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        ) else {
            urlSchemeTask.didFailWithError(URLError(.unknown))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
