import Capacitor
import Foundation
import UIKit
import UserNotifications
import WebKit

/// Local notifications for the bundled app, shaped like the Android
/// `NotifyBridge` port the PWA already speaks.
///
/// The page owns the decision of when a notice is due. This class only maps
/// `window.PairfobNotify` requests onto `UNUserNotificationCenter`, keeps the
/// permission and background-refresh facts, and delivers a tap back to the
/// page that registered through `ready`.
final class PairfobNotify: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    static let shared = PairfobNotify()

    static let refreshIdentifier = "com.pairfob.app.refresh"
    static let syncKey = "pairfob.notify.sync"

    private static let handlerName = "pairfobNotify"
    private static let maxMessageBytes = 4096
    private static let maxTapURLBytes = 512

    private weak var webView: WKWebView?
    private weak var viewController: CAPBridgeViewController?
    private var primary = false
    private var ready = false
    private var pendingTap: String?

    /// The JavaScript face of the bridge. It mirrors the synchronous
    /// `WebMessagePort` the Android shell exposes, so the PWA has one client.
    private static let shim = """
    (function () {
      if (window.PairfobNotify) return;
      window.PairfobNotify = {
        postMessage: function (message) {
          window.webkit.messageHandlers.pairfobNotify.postMessage(String(message));
        },
        onmessage: null
      };
    })();
    """

    /// A background page must report itself hidden; otherwise the producer in
    /// the page stays quiet, exactly as it does for a visible tab.
    static let hiddenScript = """
    try {
      Object.defineProperty(Document.prototype, 'visibilityState', {
        configurable: true,
        get: function () { return 'hidden'; }
      });
      Object.defineProperty(Document.prototype, 'hidden', {
        configurable: true,
        get: function () { return true; }
      });
    } catch (error) {}
    """

    /// The web view paints under the status bar, so its text has to follow the
    /// document's palette. The page already writes `data-theme` for its own
    /// tokens; watch that attribute instead of asking the PWA for a native call.
    private static let themeScript = """
    (function () {
      var root = document.documentElement;
      var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
      var last = null;
      function resolved() {
        var pref = root.getAttribute('data-theme');
        // The stylesheet paints dark until the app writes the attribute, so an
        // unmarked document must not follow the system yet.
        if (pref === 'auto') return media && media.matches ? 'light' : 'dark';
        if (pref === 'light') return 'light';
        return 'dark';
      }
      function send(force) {
        var theme = resolved();
        if (!force && theme === last) return;
        last = theme;
        try {
          window.webkit.messageHandlers.pairfobNotify.postMessage(
            JSON.stringify({ method: 'theme', theme: theme })
          );
        } catch (error) {}
      }
      if (window.MutationObserver) {
        new MutationObserver(function () { send(false); })
          .observe(root, { attributes: true, attributeFilter: ['data-theme'] });
      }
      if (media && media.addEventListener) media.addEventListener('change', function () { send(false); });
      send(true);
    })();
    """

    /// Install the port into one web view. The shared instance is the visible
    /// app; the background refresh creates its own instance so a tap meant for
    /// the app can never be consumed by the offscreen page.
    func install(webView: WKWebView, primary: Bool, viewController: CAPBridgeViewController? = nil) {
        self.webView = webView
        self.primary = primary
        self.viewController = viewController
        ready = false
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.handlerName)
        controller.add(self, name: Self.handlerName)
        controller.addUserScript(WKUserScript(
            source: Self.shim,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.addUserScript(WKUserScript(
            source: Self.themeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName,
              message.frameInfo.isMainFrame,
              allowed(message.frameInfo.securityOrigin),
              let body = message.body as? String,
              body.utf8.count <= Self.maxMessageBytes,
              let data = body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let request = object as? [String: Any],
              let method = request["method"] as? String
        else { return }

        // A theme report is fire-and-forget: no id, no reply.
        if method == "theme" {
            setStatusBar(theme: request["theme"] as? String)
            return
        }
        guard let id = request["id"] as? String,
              id.range(of: "^[0-9]{1,16}$", options: .regularExpression) != nil
        else { return }

        switch method {
        case "status":
            status(id: id)
        case "requestPermission":
            requestPermission(id: id)
        case "post":
            post(request, id: id)
        case "cancel":
            cancel(request, id: id)
        case "cancelAll":
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            respond(id: id, ok: true, value: [String: Any]())
        case "setBackgroundSync":
            setBackgroundSync(request["on"] as? Bool == true, id: id)
        case "ready":
            pageReady(id: id)
        default:
            respond(id: id, ok: false, value: "unknown method")
        }
    }

    /// The app's own document only. A debug build also accepts a live-reload
    /// server on loopback; release stays on the bundled origin.
    private func allowed(_ origin: WKSecurityOrigin) -> Bool {
        if origin.protocol == "capacitor" && origin.host == "localhost" { return true }
        #if DEBUG
        if origin.protocol == "http" || origin.protocol == "https" {
            return origin.host == "localhost" || origin.host == "127.0.0.1"
        }
        #endif
        return false
    }

    // MARK: - Requests

    /// White status-bar text on the dark palette, dark text on the light one.
    private func setStatusBar(theme: String?) {
        let style: UIStatusBarStyle
        switch theme {
        case "light":
            style = .darkContent
        case "dark":
            style = .lightContent
        default:
            return
        }
        DispatchQueue.main.async {
            self.viewController?.setStatusBarStyle(style)
        }
    }

    private func status(id: String) {
        permissionState { permission in
            let value: [String: Any] = [
                "permission": permission,
                "backgroundSync": UserDefaults.standard.bool(forKey: Self.syncKey),
            ]
            self.respond(id: id, ok: true, value: value)
        }
    }

    private func requestPermission(id: String) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                    self.permissionState { permission in
                        self.respond(id: id, ok: true, value: ["permission": permission])
                    }
                }
            } else {
                self.permissionState { permission in
                    self.respond(id: id, ok: true, value: ["permission": permission])
                }
            }
        }
    }

    private func post(_ request: [String: Any], id: String) {
        guard let title = text(request, "title", 200),
              let body = text(request, "body", 500),
              let tag = text(request, "tag", 120),
              let url = tapURL(request["url"])
        else {
            respond(id: id, ok: false, value: "notification request failed")
            return
        }
        permissionState { permission in
            guard permission == "granted" else {
                self.respond(id: id, ok: false, value: "notifications are disabled")
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            // One identifier per pane: a completed turn replaces a stale
            // needs-you notice instead of stacking another row.
            content.threadIdentifier = tag
            content.userInfo = ["url": url]
            let notification = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(notification) { error in
                if error == nil {
                    self.respond(id: id, ok: true, value: ["posted": true])
                } else {
                    self.respond(id: id, ok: false, value: "notification request failed")
                }
            }
        }
    }

    private func cancel(_ request: [String: Any], id: String) {
        guard let tag = text(request, "tag", 120) else {
            respond(id: id, ok: false, value: "notification request failed")
            return
        }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [tag])
        center.removeDeliveredNotifications(withIdentifiers: [tag])
        respond(id: id, ok: true, value: ["cancelled": true])
    }

    private func setBackgroundSync(_ on: Bool, id: String) {
        if on {
            do {
                try PairfobNotify.scheduleRefresh()
            } catch {
                UserDefaults.standard.set(false, forKey: Self.syncKey)
                respond(id: id, ok: false, value: "background sync is not available on this device")
                return
            }
            UserDefaults.standard.set(true, forKey: Self.syncKey)
        } else {
            UserDefaults.standard.set(false, forKey: Self.syncKey)
            PairfobNotify.cancelRefresh()
        }
        respond(id: id, ok: true, value: ["backgroundSync": on])
    }

    private func pageReady(id: String) {
        guard primary else {
            respond(id: id, ok: true, value: ["tap": NSNull()])
            return
        }
        ready = true
        if let tap = pendingTap {
            pendingTap = nil
            respond(id: id, ok: true, value: ["tap": ["url": tap]])
        } else {
            respond(id: id, ok: true, value: ["tap": NSNull()])
        }
    }

    private func permissionState(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let state: String
            switch settings.authorizationStatus {
            case .notDetermined:
                state = "prompt"
            case .denied:
                state = "denied"
            case .authorized, .provisional, .ephemeral:
                state = "granted"
            @unknown default:
                state = "denied"
            }
            done(state)
        }
    }

    private func text(_ request: [String: Any], _ key: String, _ max: Int) -> String? {
        guard let value = request[key] as? String, !value.isEmpty, value.count <= max else { return nil }
        return value
    }

    private func tapURL(_ value: Any?) -> String? {
        guard let url = value as? String,
              url.hasPrefix("/pair#"),
              url.utf8.count <= Self.maxTapURLBytes
        else { return nil }
        return url
    }

    // MARK: - Taps and notification presentation

    /// A tap that cold-starts the app has no page to talk to yet; keep it until
    /// the page calls `ready`.
    func onTap(_ url: String) {
        guard url.hasPrefix("/pair#"), url.utf8.count <= Self.maxTapURLBytes else { return }
        guard primary, ready, let webView = webView else {
            pendingTap = url
            return
        }
        deliverTap(url, to: webView)
    }

    private func deliverTap(_ url: String, to webView: WKWebView) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["event": "tap", "url": url]),
              let json = String(data: data, encoding: .utf8),
              let quoted = jsString(json)
        else { return }
        let script = "window.PairfobNotify&&window.PairfobNotify.onmessage&&"
            + "window.PairfobNotify.onmessage({data:\(quoted)})"
        webView.evaluateJavaScript(script) { _, error in
            guard error != nil else { return }
            // The document may have gone away mid-delivery; let the next
            // `ready` hand the tap to the page that replaces it.
            self.ready = false
            self.pendingTap = url
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let url = response.notification.request.content.userInfo["url"] as? String
        DispatchQueue.main.async {
            if let url = url { self.onTap(url) }
            completionHandler()
        }
    }

    // MARK: - Replies

    private func respond(id: String, ok: Bool, value: Any) {
        var payload: [String: Any] = ["id": id, "ok": ok]
        if ok {
            payload["value"] = value
        } else {
            payload["error"] = value
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8),
              let quoted = jsString(json)
        else { return }
        let script = "window.PairfobNotify&&window.PairfobNotify.onmessage&&"
            + "window.PairfobNotify.onmessage({data:\(quoted)})"
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func jsString(_ value: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
