/**
 * Where this build keeps the relay.
 *
 * The web build is served by the relay, so the page origin is the relay origin.
 * The native shell serves the same PWA from a local WebView origin and talks to
 * a separate relay origin. Every relay-bound URL goes through this module so a
 * native build cannot silently keep using `location.origin`.
 */

export type RuntimeMode = "web" | "native";

export type RuntimeConfig = {
  mode: RuntimeMode;
  /** Absolute http(s) origin, normalized with no trailing slash. */
  relayOrigin: string;
};

export type RuntimeEnv = {
  VITE_PAIRFOB_NATIVE?: string;
  VITE_PAIRFOB_RELAY_ORIGIN?: string;
  VITE_PAIRFOB_DOWNLOAD_ORIGIN?: string;
};

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * An absolute http(s) origin with no path, query, credentials or trailing slash.
 *
 * Native builds call this without options, so a plain-http relay must be
 * loopback. The web build passes `allowInsecureHttp` because its page origin is
 * the relay and LAN development over http is an existing supported setup.
 */
export function normalizeRelayOrigin(value: string, options?: { allowInsecureHttp?: boolean }): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid relay origin: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Relay origin must be http(s): ${value}`);
  }
  if (!url.host || url.username || url.password) throw new Error(`Invalid relay origin: ${value}`);
  if (url.pathname !== "/" && url.pathname !== "") throw new Error(`Relay origin must not have a path: ${value}`);
  if (url.search || url.hash) throw new Error(`Relay origin must not have a query or fragment: ${value}`);
  // An http native relay is a local development target, never something to ship.
  if (url.protocol === "http:" && !options?.allowInsecureHttp && !loopback(url.hostname)) {
    throw new Error(`Non-loopback relay origin must use https: ${value}`);
  }
  return url.origin;
}

/**
 * The one place the mode and relay origin are decided.
 *
 * Native mode is explicit: `VITE_PAIRFOB_NATIVE=1` plus a relay origin. Web
 * mode ignores the relay override and keeps the page origin, so a native-only
 * variable can never retarget the hosted app.
 */
export function parseRuntimeConfig(env: RuntimeEnv, pageOrigin: string): RuntimeConfig {
  if (env.VITE_PAIRFOB_NATIVE === "1") {
    const raw = env.VITE_PAIRFOB_RELAY_ORIGIN?.trim() ?? "";
    if (!raw) throw new Error("VITE_PAIRFOB_NATIVE=1 requires VITE_PAIRFOB_RELAY_ORIGIN");
    return { mode: "native", relayOrigin: normalizeRelayOrigin(raw) };
  }
  return { mode: "web", relayOrigin: normalizeRelayOrigin(pageOrigin, { allowInsecureHttp: true }) };
}

function buildEnv(): RuntimeEnv {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env ?? {};
  return {
    VITE_PAIRFOB_NATIVE: typeof env.VITE_PAIRFOB_NATIVE === "string" ? env.VITE_PAIRFOB_NATIVE : undefined,
    VITE_PAIRFOB_RELAY_ORIGIN: typeof env.VITE_PAIRFOB_RELAY_ORIGIN === "string" ? env.VITE_PAIRFOB_RELAY_ORIGIN : undefined,
    VITE_PAIRFOB_DOWNLOAD_ORIGIN: typeof env.VITE_PAIRFOB_DOWNLOAD_ORIGIN === "string" ? env.VITE_PAIRFOB_DOWNLOAD_ORIGIN : undefined,
  };
}

/**
 * The page's own origin. The fallback exists for headless tests and non-browser
 * imports; a running app always has `location`.
 */
export function pageOrigin(): string {
  if (typeof location !== "undefined") {
    if (location.origin && location.origin !== "null") return location.origin;
    // The iOS shell serves the app from a non-special scheme, whose
    // `location.origin` is the string "null". Rebuild the base from the
    // scheme and host so relative app links can still be parsed.
    if (location.protocol && location.host) return `${location.protocol}//${location.host}`;
  }
  return "http://localhost";
}

export function runtimeConfig(): RuntimeConfig {
  return parseRuntimeConfig(buildEnv(), pageOrigin());
}

export function isNativeRuntime(): boolean {
  return runtimeConfig().mode === "native";
}

export function relayOrigin(): string {
  return runtimeConfig().relayOrigin;
}

/**
 * The relay host as the reader sees it. The web build is served by the relay,
 * so this is the page's own hostname; on the official instance it reads
 * `pairfob.com`. Copy that names the relay passes this instead of hardcoding
 * the official host, so a self-hosted relay does not point readers elsewhere.
 */
export function relayHost(): string {
  return relayHostFor(relayOrigin());
}

/** The host of an origin, or the official host when it cannot be read. */
export function relayHostFor(origin: string): string {
  try {
    return new URL(origin).hostname || "pairfob.com";
  } catch {
    return "pairfob.com";
  }
}

/** An absolute URL on the given relay origin. `path` should start with `/`. */
export function relayURLFor(origin: string, path: string): string {
  return new URL(path, normalizeRelayOrigin(origin, { allowInsecureHttp: true })).toString();
}

/** An absolute relay URL. `path` should start with `/`. */
export function relayURL(path: string): string {
  return relayURLFor(relayOrigin(), path);
}

/** Convert an http(s) origin plus path into its ws(s) URL. */
export function webSocketURLFor(origin: string, path: string): string {
  const url = new URL(path, normalizeRelayOrigin(origin, { allowInsecureHttp: true }));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function relayWebSocketURL(path: string): string {
  return webSocketURLFor(relayOrigin(), path);
}

/**
 * The Android beta channel's host. It is separate from the relay so publishing
 * an APK does not deploy the relay or reset its WebSockets. Native development
 * can point it at a loopback relay.
 */
const DEFAULT_DOWNLOAD_ORIGIN = "https://dl.pairfob.com";

export function downloadOrigin(): string {
  const raw = buildEnv().VITE_PAIRFOB_DOWNLOAD_ORIGIN?.trim();
  return raw ? normalizeRelayOrigin(raw) : DEFAULT_DOWNLOAD_ORIGIN;
}

export function downloadURL(path: string): string {
  return new URL(path, downloadOrigin()).toString();
}
