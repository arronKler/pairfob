import { handleAdmin } from "./admin.ts";
import { CSP_SITE, DAEMON_ID_RE, PROTOCOL, SUBPROTOCOL } from "./constants.ts";
import { handleEnroll } from "./enroll.ts";
import { handleEvents, observeDocument } from "./events.ts";
import { getDaemon } from "./d1.ts";
import type { Env } from "./env.ts";
import {
  applySecurityHeaders,
  buildOf,
  clientIP,
  errorJson,
  hasBrowserOrigin,
  isSameHostOrigin,
  jsonResponse,
  noStore,
  offeredSubprotocol,
  unpairedJson,
  wantsUpgrade,
  withSecurity,
} from "./http.ts";
import { allowSessionIP } from "./limits.ts";
import { observeError, observeUpgrade } from "./metrics.ts";
import { handlePairIntent } from "./pair-intent.ts";
import { handleRekey } from "./rekey.ts";
import { handleSignup } from "./signup.ts";

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Pairfob</title><h1>Pairfob</h1><p>Hosted origin. Production copies pwa/dist into R2.</p>`;

export async function handleFetch(req: Request, env: Env): Promise<Response> {
  const build = buildOf(env);
  const url = new URL(req.url);
  const path = url.pathname;

  const apex = apexRedirect(url, req.method, path);
  if (apex) return apex;

  const legacy = legacyEnRedirect(req.method, path);
  if (legacy) return legacy;

  if (path === "/v1/ws") {
    return errorJson(build, 426, "unbound", { "Sec-WebSocket-Protocol": SUBPROTOCOL });
  }

  if (path === "/v2/health" && req.method === "GET") {
    return jsonResponse(build, 200, { ok: true, protocol: PROTOCOL });
  }

  if (path === "/api/config" && req.method === "GET") {
    return jsonResponse(build, 200, { protocol: PROTOCOL, build, p2p: env.P2P_OPEN === "1" }, noStore());
  }

  if (path === "/v2/enroll") return handleEnroll(req, env);
  if (path === "/v2/rekey") return handleRekey(req, env);
  if (path === "/v2/pair-intent") return handlePairIntent(req, env);
  if (path === "/v2/events") return handleEvents(req, env);
  if (path === "/v2/grants") return handleSignup(req, env);

  const admin = await handleAdmin(req, env);
  if (admin) return admin;

  if (path === "/v2/ws") return routeWs(req, env);

  return staticOrPlaceholder(req, env, build);
}

/**
 * `www` and the apex are both custom domains, which is duplicate content for
 * crawlers. Only readable pages are redirected: a WebSocket handshake cannot
 * follow one, and a redirected enroll would resend credentials to a second host.
 */
function apexRedirect(url: URL, method: string, path: string): Response | null {
  if (url.hostname !== "www.pairfob.com") return null;
  if (method !== "GET" && method !== "HEAD") return null;
  if (path.startsWith("/v1/") || path.startsWith("/v2/") || path.startsWith("/api/")) return null;
  const target = new URL(url.toString());
  target.hostname = "pairfob.com";
  return movedTo(target.toString());
}

/**
 * English used to live under /en while Chinese held the bare path. The two
 * swapped, so the retired URLs must not 404 for anything already linking them.
 */
function legacyEnRedirect(method: string, path: string): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (path === "/en" || path === "/en/" || path === "/en/index.html") return movedTo("/");
  if (path === "/doc/en" || path === "/doc/en/") return movedTo("/doc/");
  if (path.startsWith("/doc/en/")) return movedTo("/doc/" + path.slice("/doc/en/".length));
  return null;
}

function movedTo(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: location, "Cache-Control": "max-age=3600" },
  });
}

async function routeWs(req: Request, env: Env): Promise<Response> {
  const build = buildOf(env);
  const url = new URL(req.url);

  if (url.searchParams.has("pair_loc")) {
    observeError(env, "unpaired");
    return unpairedJson(build, noStore());
  }

  if (!wantsUpgrade(req) && req.method !== "GET") {
    return errorJson(build, 405, "bad_token", noStore());
  }

  if (!offeredSubprotocol(req, SUBPROTOCOL)) {
    return errorJson(build, 426, "unbound", { "Sec-WebSocket-Protocol": SUBPROTOCOL });
  }

  const role = url.searchParams.get("role") || "";
  const daemonId = url.searchParams.get("daemon_id") || "";
  if (role !== "daemon" && role !== "client") {
    return errorJson(build, 400, "bad_token", noStore());
  }
  if (!daemonId) return errorJson(build, 400, "bad_token", noStore());
  if (!DAEMON_ID_RE.test(daemonId)) return errorJson(build, 400, "bad_token", noStore());

  if (role === "client") {
    if (!hasBrowserOrigin(req) || !isSameHostOrigin(req)) {
      return errorJson(build, 403, "forbidden", noStore());
    }
  } else if (!isSameHostOrigin(req)) {
    return errorJson(build, 403, "forbidden", noStore());
  }

  const daemon = await getDaemon(env.DB, daemonId);
  if (!daemon || daemon.kicked_at != null) {
    return errorJson(build, 400, "bad_token", noStore());
  }

  const ticket = url.searchParams.get("pair_ticket");
  if (role === "client" && (ticket === null || ticket === "")) {
    if (!allowSessionIP(clientIP(req), Date.now())) {
      observeError(env, "rate_limited", daemonId);
      return errorJson(build, 429, "rate_limited", noStore());
    }
  }

  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(daemonId));
  const res = await stub.fetch(req);
  if (res.status === 101) {
    observeUpgrade(env, role, daemonId);
    return res;
  }
  return withSecurity(build, res);
}

async function staticOrPlaceholder(req: Request, env: Env, build: string): Promise<Response> {
  if (env.ASSETS) {
    const url = new URL(req.url);
    let assetReq = req;
    if (isPairAppPath(url.pathname)) {
      // HTML asset normalization redirects /pair/index.html back to /pair.
      // Fetch an opaque asset name so the Worker, not Assets, owns the public
      // canonical route and cannot create a self-redirect.
      assetReq = new Request(new URL("/pair-shell.asset", url.origin), req);
    } else if (isAltMarketingPath(url.pathname)) {
      // Same trap: /index.html canonicalizes to `/`, which would bounce /zh.
      assetReq = new Request(new URL("/zh-shell.asset", url.origin), req);
    }
    const res = await followDocAsset(env.ASSETS, req, url, await env.ASSETS.fetch(assetReq));
    observeDocument(env, req.method, url.pathname, res.status);
    return withSecurity(build, res, staticAssetHeaders(url.pathname, res.ok));
  }
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  applySecurityHeaders(headers, build);
  return new Response(PLACEHOLDER, { status: 200, headers });
}

/** English owns the bare path; Chinese is served from the same document at /zh. */
function isAltMarketingPath(path: string): boolean {
  return path === "/zh" || path === "/zh/" || path === "/zh/index.html";
}

function isPairAppPath(path: string): boolean {
  return path === "/pair" || path === "/pair/" || path === "/pair.html";
}

function isMarketingDocument(path: string): boolean {
  return path === "/" || path === "/index.html" || isAltMarketingPath(path);
}

function isDocPath(path: string): boolean {
  return path === "/doc" || path.startsWith("/doc/");
}

/**
 * VitePress is mounted at `/doc/`. `drop-trailing-slash` 307s `/doc/` and
 * `/doc/zh/` to the slashless folder URL, so the homepage Docs link never
 * lands on the docs page. Follow that hop internally and keep the public URL.
 */
async function followDocAsset(assets: Fetcher, req: Request, url: URL, res: Response): Promise<Response> {
  if (!isDocPath(url.pathname) || res.status < 300 || res.status >= 400) return res;
  const location = res.headers.get("Location");
  if (!location) return res;
  let next: URL;
  try {
    next = new URL(location, url);
  } catch {
    return res;
  }
  if (next.origin !== url.origin || !isDocPath(next.pathname) || next.href === url.href) return res;
  const followed = await assets.fetch(
    new Request(next, { method: req.method, headers: req.headers, redirect: "manual" }),
  );
  if (followed.status >= 300 && followed.status < 400) return res;
  return followed;
}

function staticAssetHeaders(path: string, ok: boolean): Record<string, string> | undefined {
  if (!ok) return undefined;
  if (isPairAppPath(path)) {
    return { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
  }
  // Marketing and docs have no Wasm; `/pair` keeps the PWA-specific policy above.
  if (isMarketingDocument(path) || isDocPath(path)) {
    const headers: Record<string, string> = { "Content-Security-Policy": CSP_SITE };
    if (isAltMarketingPath(path)) headers["Content-Type"] = "text/html; charset=utf-8";
    return headers;
  }
  if (path === "/install.sh") {
    return { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "max-age=300" };
  }
  if (path === "/dl/VERSION" || path === "/dl/SHA256SUMS") {
    return { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  }
  if (path.startsWith("/dl/")) {
    return { "Cache-Control": "public, max-age=3600" };
  }
  return undefined;
}
