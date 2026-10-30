/**
 * Daemon and Android downloads share this Worker independently of the relay.
 */
import { daemonDownload } from "./daemon";
import { desktopDownload } from "./desktop";

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

const APP_ORIGIN = "https://localhost";
const MANIFEST = "/android/beta/latest.json";
const LATEST_APK = "/android/beta/latest.apk";
const APK = /^\/android\/beta\/[A-Za-z0-9._-]+\.apk$/;

function cors(req: Request): Record<string, string> {
  if (req.headers.get("Origin") !== APP_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function headers(res: Response, extra: Record<string, string>): Headers {
  const merged = new Headers(res.headers);
  merged.set("X-Content-Type-Options", "nosniff");
  for (const [key, value] of Object.entries(extra)) merged.set(key, value);
  return merged;
}

/** Point the stable link at whatever version the manifest currently names. */
async function latestAPK(env: Env, url: URL): Promise<Response> {
  const manifest = await env.ASSETS.fetch(new Request(new URL(MANIFEST, url)));
  let path: unknown;
  if (manifest.ok) {
    try {
      const data = (await manifest.json()) as { url?: unknown };
      path = data.url;
    } catch {
      /* handled below */
    }
  }
  if (typeof path !== "string" || !APK.test(path) || path === LATEST_APK) {
    return new Response(null, {
      status: 502,
      headers: headers(new Response(null), { "Cache-Control": "no-store" }),
    });
  }
  return new Response(null, {
    status: 302,
    headers: headers(new Response(null), { Location: path, "Cache-Control": "no-store" }),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const daemon = await daemonDownload(req, env.ASSETS);
    if (daemon) return daemon;
    const desktop = await desktopDownload(req, env.ASSETS);
    if (desktop) return desktop;
    const url = new URL(req.url);
    const metadata = url.pathname === MANIFEST || url.pathname === "/android/beta/previous.json"
      || /^\/android\/beta\/[A-Za-z0-9._-]+\.apk\.provenance\.json$/.test(url.pathname);
    if (!metadata && !APK.test(url.pathname)) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (req.method === "OPTIONS" && url.pathname === MANIFEST) {
      return new Response(null, {
        status: 204,
        headers: headers(new Response(null), {
          ...cors(req),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Max-Age": "600",
        }),
      });
    }
    if (url.pathname === LATEST_APK && (req.method === "GET" || req.method === "HEAD")) {
      return latestAPK(env, url);
    }
    const res = await env.ASSETS.fetch(req);
    if (url.pathname === MANIFEST) {
      return new Response(res.body, {
        status: res.status,
        headers: headers(res, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...cors(req),
        }),
      });
    }
    if (APK.test(url.pathname)) {
      return new Response(res.body, {
        status: res.status,
        headers: headers(res, res.ok
          ? {
            "Content-Type": "application/vnd.android.package-archive",
            "Cache-Control": "public, max-age=31536000, immutable",
          }
          : {
            "Content-Type": "application/vnd.android.package-archive",
            "Cache-Control": "no-store",
          }),
      });
    }
    return new Response(res.body, { status: res.status, headers: headers(res, { "Cache-Control": "no-store" }) });
  },
};
