import { PROTOCOL, TICKET_MS } from "./constants.ts";
import { indexName, normalizeLoc } from "./crockford.ts";
import type { Env } from "./env.ts";
import { buildOf, clientIP, errorJson, jsonResponse, noStore, readJSON, requireSameHostBrowserOrigin, unpairedJson } from "./http.ts";
import { allowIntentIP } from "./limits.ts";
import { observeError, observeIntent } from "./metrics.ts";

export type UnpairedBody = { ok: false; error: { code: "unpaired" } };

export const UNPAIRED_BODY: UnpairedBody = { ok: false, error: { code: "unpaired" } };

async function padMiss(env: Env, started: number): Promise<void> {
  const pad = Number(env.INTENT_PAD_MS ?? "15");
  if (!Number.isFinite(pad) || pad <= 0) return;
  const elapsed = Date.now() - started;
  const wait = pad - elapsed;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function handlePairIntent(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const build = buildOf(env);
  const store = noStore();
  if (req.method !== "POST") return errorJson(build, 405, "bad_token", store);
  if (!requireSameHostBrowserOrigin(req)) return errorJson(build, 403, "forbidden", store);

  const ip = clientIP(req);
  if (!allowIntentIP(ip, now)) {
    observeIntent(env, "rate_limited");
    observeError(env, "rate_limited");
    return errorJson(build, 429, "rate_limited", store);
  }

  const started = Date.now();
  const body = await readJSON(req);
  const rawLoc = typeof body?.pair_loc === "string" ? body.pair_loc : "";
  const loc = body && body.v === PROTOCOL ? normalizeLoc(rawLoc) : null;
  if (!loc) {
    await padMiss(env, started);
    observeIntent(env, "unpaired");
    return unpairedJson(build, store);
  }

  const found = await lookupIndex(env, loc);
  if (!found) {
    await padMiss(env, started);
    observeIntent(env, "unpaired");
    return unpairedJson(build, store);
  }

  const ticket = await issueTicket(env, found.daemon_id, loc);
  if (!ticket) {
    await padMiss(env, started);
    observeIntent(env, "unpaired", found.daemon_id);
    return unpairedJson(build, store);
  }

  observeIntent(env, "ok", found.daemon_id);
  return jsonResponse(
    build,
    200,
    {
      ok: true,
      v: PROTOCOL,
      daemon_id: found.daemon_id,
      pair_ref: ticket.pair_ref,
      pair_ticket: ticket.pair_ticket,
      expires_in: Math.round(TICKET_MS / 1000),
    },
    store,
  );
}

async function lookupIndex(env: Env, loc: string): Promise<{ daemon_id: string; pair_ref: string } | null> {
  try {
    const id = env.PAIRING_INDEX.idFromName(indexName(loc));
    const res = await env.PAIRING_INDEX.get(id).fetch(
      new Request("https://pairfob.internal/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair_loc: loc }),
      }),
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; daemon_id?: string; pair_ref?: string };
    if (!j.ok || !j.daemon_id || !j.pair_ref) return null;
    return { daemon_id: j.daemon_id, pair_ref: j.pair_ref };
  } catch {
    return null;
  }
}

async function issueTicket(
  env: Env,
  daemonId: string,
  loc: string,
): Promise<{ pair_ticket: string; pair_ref: string } | null> {
  try {
    const id = env.DAEMON_ROOM.idFromName(daemonId);
    const res = await env.DAEMON_ROOM.get(id).fetch(
      new Request("https://pairfob.internal/internal/issue-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair_loc: loc }),
      }),
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; pair_ticket?: string; pair_ref?: string };
    if (!j.ok || !j.pair_ticket || !j.pair_ref) return null;
    return { pair_ticket: j.pair_ticket, pair_ref: j.pair_ref };
  } catch {
    return null;
  }
}
