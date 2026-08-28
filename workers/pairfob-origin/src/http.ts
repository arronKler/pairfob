import { BUILD_DEFAULT, CSP, SUBPROTOCOL } from "./constants.ts";

export type ErrorBody = { ok: false; error: { code: string; message?: string } };

export function buildOf(env: { BUILD?: string }): string {
  return env.BUILD || BUILD_DEFAULT;
}

export function applySecurityHeaders(headers: Headers, build: string): void {
  headers.set("X-Pairfob-Build", build);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
}

export function jsonResponse(
  build: string,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  applySecurityHeaders(headers, build);
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

export function noStore(extra?: Record<string, string>): Record<string, string> {
  return { "Cache-Control": "no-store", ...(extra ?? {}) };
}

export function errorJson(build: string, status: number, code: string, extra?: Record<string, string>): Response {
  const body: ErrorBody = { ok: false, error: { code } };
  return jsonResponse(build, status, body, extra);
}

export function unpairedJson(build: string, extra?: Record<string, string>): Response {
  return errorJson(build, 404, "unpaired", extra);
}

export function withSecurity(build: string, res: Response, extra?: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  applySecurityHeaders(headers, build);
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const init: ResponseInit & { webSocket?: WebSocket } = {
    status: res.status,
    statusText: res.statusText,
    headers,
  };
  if (res.webSocket) init.webSocket = res.webSocket;
  return new Response(res.status === 101 ? null : res.body, init);
}

export function clientIP(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || "127.0.0.1";
}

export function requestHost(req: Request): string {
  return req.headers.get("Host") || new URL(req.url).host;
}

export function originValue(req: Request): string | null {
  if (!req.headers.has("Origin")) return null;
  return req.headers.get("Origin") ?? "";
}

/** Empty Origin is allowed. Present Origin must be same-host http(s) with no path/query/user. */
export function isSameHostOrigin(req: Request): boolean {
  const origin = originValue(req);
  if (origin === null || origin === "") return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return false;
  if (u.pathname !== "/" && u.pathname !== "") return false;
  if (u.search !== "" || u.hash !== "") return false;
  if (!u.host) return false;
  return u.host.toLowerCase() === requestHost(req).toLowerCase();
}

export function hasBrowserOrigin(req: Request): boolean {
  const o = originValue(req);
  return o !== null && o !== "";
}

export function requireSameHostBrowserOrigin(req: Request): boolean {
  const o = originValue(req);
  if (o === null || o === "") return false;
  return isSameHostOrigin(req);
}

export function offeredSubprotocol(req: Request, name: string): boolean {
  const raw = req.headers.get("Sec-WebSocket-Protocol") || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes(name);
}

export function wantsUpgrade(req: Request): boolean {
  return (req.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

export function v2ProtocolHeaders(): Record<string, string> {
  return { "Sec-WebSocket-Protocol": SUBPROTOCOL };
}

export async function readJSON(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return m ? m[1] : null;
}
