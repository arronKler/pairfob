import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The scheme is the app's WebView origin and must be chosen with the relay:
 * production is `https://localhost` against `https://pairfob.com`; a local
 * development build is `http://localhost` against `http://127.0.0.1:18786`.
 * The mobile scripts set both explicitly. Changing the scheme changes the
 * IndexedDB origin, so credentials do not carry across the two builds.
 */
const scheme: "http" | "https" = process.env.PAIRFOB_ANDROID_SCHEME === "http" ? "http" : "https";

/**
 * iOS cannot use `https` here. WebKit already owns that scheme, so Capacitor's
 * `WKWebView.handlesURLScheme` check rejects it and falls back to
 * `capacitor://localhost`. The native bridge accepts exactly that origin; keep
 * it unless the bridge and the PWA's non-http origin handling change together.
 */
const iosScheme = "capacitor";

const config: CapacitorConfig = {
  appId: "com.pairfob.app",
  appName: "Pairfob",
  webDir: "../pwa/dist-native",
  server: {
    hostname: "localhost",
    androidScheme: scheme,
    iosScheme,
  },
};

export default config;
