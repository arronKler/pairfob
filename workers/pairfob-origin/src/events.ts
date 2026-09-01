import type { Env } from "./env.ts";
import { buildOf, errorJson, jsonResponse, noStore, requireSameHostBrowserOrigin, clientIP, readJSON } from "./http.ts";
import { allowEventsIP } from "./limits.ts";
import { observeBeacon, observeError, observePage } from "./metrics.ts";

/** Client beacons may only emit these names. Mux/ops events are server-authored. */
export const BEACON_EVENTS = new Set([
  "pwa_boot",
  "pwa_pairing_start",
  "pwa_pairing_result",
  "pwa_resume",
  "pwa_live",
  "pwa_disconnect",
  "pwa_terminal",
  "pwa_agent_trace",
  "pwa_settings",
  "pwa_p2p",
  "pwa_add_computer",
  "site_copy",
]);

const RESULT_RE = /^[a-z][a-z0-9_]{0,47}$/;
const SECRET_PREFIX = /^(jg_|rt_|it_|d_|g_)/;
const MAX_EVENTS = 8;

function tokenField(value: unknown): string {
  if (typeof value !== "string" || !RESULT_RE.test(value) || SECRET_PREFIX.test(value)) return "";
  return value;
}

export function pageClass(path: string): string | null {
  if (path === "/" || path === "/index.html") return "home";
  if (path === "/zh" || path === "/zh/" || path === "/zh/index.html") return "home_zh";
  if (path === "/pair" || path === "/pair/" || path === "/pair.html") return "pair";
  if (path === "/doc" || path.startsWith("/doc/")) return "docs";
  if (path === "/install.sh") return "install";
  if (path.startsWith("/dl/")) return "download";
  return null;
}

export function observeDocument(env: Env, method: string, path: string, status: number): void {
  if (method !== "GET") return;
  if (status < 200 || status >= 300) return;
  const klass = pageClass(path);
  if (klass) observePage(env, klass);
}

export async function handleEvents(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const build = buildOf(env);
  const store = noStore();
  if (req.method !== "POST") return errorJson(build, 405, "bad_token", store);
  if (!requireSameHostBrowserOrigin(req)) return errorJson(build, 403, "forbidden", store);
  if (!allowEventsIP(clientIP(req), now)) {
    observeError(env, "rate_limited");
    return errorJson(build, 429, "rate_limited", store);
  }

  const body = await readJSON(req);
  const raw = body && Array.isArray(body.events) ? body.events : null;
  if (!body || body.v !== 2 || !raw || raw.length === 0 || raw.length > MAX_EVENTS) {
    return errorJson(build, 400, "bad_token", store);
  }

  let accepted = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    if (!BEACON_EVENTS.has(name)) continue;
    const result = tokenField(rec.result);
    const extra = tokenField(rec.extra);
    observeBeacon(env, name, result, extra);
    accepted++;
  }
  if (!accepted) return errorJson(build, 400, "bad_token", store);
  return jsonResponse(build, 200, { ok: true, accepted }, store);
}
