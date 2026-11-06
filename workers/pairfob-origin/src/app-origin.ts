import type { Env } from "./env.ts";
import { isSameHostOrigin, originValue } from "./http.ts";

/**
 * Exact app origins allowed to call the relay from a web view: the Android
 * shell loads its bundle from `https://localhost` (Capacitor's Android
 * origin), and the iOS shell from `capacitor://localhost`. A plain
 * `http://localhost` build is a development-only target and requires the
 * explicit `ALLOW_HTTP_APP_ORIGINS=1` var; production never sets it.
 */
const DEV_HTTP_APP_ORIGIN = "http://localhost";

/**
 * Capacitor cannot serve the iOS app from `https` (WebKit owns the scheme), so
 * the iOS shell loads from `capacitor://localhost` and every request it makes
 * carries that exact Origin. A web page cannot produce a custom-scheme origin,
 * so this is the same native-shell trust as the Android entry above; the
 * pairing code and the session keys remain the only authority.
 */
const IOS_APP_ORIGIN = "capacitor://localhost";

function canonicalAppOrigin(value: string, allowHttp: boolean): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Require the canonical origin spelling: no trailing slash, path, or case drift.
  if (url.origin !== value) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.protocol === "http:" && !(allowHttp && url.hostname === "localhost")) return null;
  return url.origin;
}

export function appOrigins(env: Env): ReadonlySet<string> {
  const allowHttp = env.ALLOW_HTTP_APP_ORIGINS === "1";
  const origins = new Set<string>();
  for (const entry of (env.APP_ORIGINS ?? "").split(",")) {
    const origin = canonicalAppOrigin(entry.trim(), allowHttp);
    if (origin) origins.add(origin);
  }
  origins.add(IOS_APP_ORIGIN);
  if (allowHttp) origins.add(DEV_HTTP_APP_ORIGIN);
  return origins;
}

export function isAppOrigin(origin: string, env: Env): boolean {
  return appOrigins(env).has(origin);
}

/** A request whose Origin is exactly one of the configured app origins. */
export function hasAppOrigin(req: Request, env: Env): boolean {
  const origin = originValue(req);
  return origin !== null && origin !== "" && isAppOrigin(origin, env);
}

/**
 * Client WebSocket: no Origin at all is a native client, and a present Origin
 * must be same-host or an exact app origin. A browser always sends one on a
 * WebSocket handshake, so accepting its absence opens nothing to a web page:
 * the pairing code and the session keys stay the only authority.
 */
export function isAllowedClientOrigin(req: Request, env: Env): boolean {
  const origin = originValue(req);
  if (origin === null) return true;
  if (origin === "") return false;
  return isSameHostOrigin(req) || isAppOrigin(origin, env);
}

/** Browser HTTP calls (pair-intent, events): non-empty and same-host or an app origin. */
export function requireAllowedBrowserOrigin(req: Request, env: Env): boolean {
  const origin = originValue(req);
  if (origin === null || origin === "") return false;
  return isSameHostOrigin(req) || isAppOrigin(origin, env);
}

/**
 * CORS response headers only when the caller is an exact app origin.
 * `Allow-Credentials` is required because `navigator.sendBeacon` sends the
 * telemetry POST with credentials mode `include`.
 */
export function appCorsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = originValue(req);
  if (!origin || !isAppOrigin(origin, env)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function appPreflight(req: Request, env: Env): Response {
  const origin = originValue(req);
  if (!origin || !isAppOrigin(origin, env)) {
    return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  }
  // Reflect only headers the app actually uses. `cache: "no-store"` makes the
  // browser send Cache-Control and Pragma, which would otherwise fail CORS.
  const requested = (req.headers.get("Access-Control-Request-Headers") || "")
    .toLowerCase()
    .split(",")
    .map((header) => header.trim())
    .filter((header) => header === "content-type" || header === "cache-control" || header === "pragma");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": requested.length ? requested.join(", ") : "content-type",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

/** Add app CORS headers to an existing response without dropping its security headers. */
export function withCors(res: Response, extra: Record<string, string>): Response {
  if (!Object.keys(extra).length) return res;
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
