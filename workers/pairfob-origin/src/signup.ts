import { SELF_GRANT_MAX_DAEMONS, SELF_GRANT_PER_IP, SELF_GRANT_WINDOW_MS } from "./constants.ts";
import { hmacSha256Hex, randomHex, sha256Hex } from "./crypto.ts";
import { insertSelfServeGrant } from "./d1.ts";
import type { Env } from "./env.ts";
import {
  buildOf,
  clientIP,
  errorJson,
  jsonResponse,
  noStore,
  requireSameHostBrowserOrigin,
} from "./http.ts";
import { allowSignupIP } from "./limits.ts";
import { observeError, observeSignup } from "./metrics.ts";

/** New computer setup is public by default. SIGNUP_OPEN=0 is the cost valve. */
function signupOpen(env: Env): boolean {
  return env.SIGNUP_OPEN !== "0";
}

export async function handleSignup(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const build = buildOf(env);
  const store = noStore();
  if (req.method === "GET") {
    return jsonResponse(
      build,
      200,
      {
        ok: true,
        open: signupOpen(env),
        max_daemons: SELF_GRANT_MAX_DAEMONS,
      },
      store,
    );
  }
  if (req.method !== "POST") return errorJson(build, 405, "bad_token", store);

  // Browser-only surface, unlike /v2/enroll which must not carry an Origin.
  if (!requireSameHostBrowserOrigin(req)) return errorJson(build, 403, "forbidden", store);
  if (!signupOpen(env)) {
    observeSignup(env, "forbidden");
    return errorJson(build, 403, "forbidden", store);
  }
  if (!env.IP_HASH_PEPPER) return errorJson(build, 500, "internal", store);

  const ip = clientIP(req);
  if (!allowSignupIP(ip, now)) {
    observeSignup(env, "rate_limited");
    observeError(env, "rate_limited");
    return errorJson(build, 429, "rate_limited", store);
  }

  const join_grant = "jg_" + randomHex(16);
  const claimed = await insertSelfServeGrant(env.DB, {
    grant_id: "g_" + randomHex(8),
    grant_hash: await sha256Hex(join_grant),
    ip_hash: await hmacSha256Hex(env.IP_HASH_PEPPER, ip),
    max_daemons: SELF_GRANT_MAX_DAEMONS,
    label: "self-serve",
    created_at: now,
    window_start: now - SELF_GRANT_WINDOW_MS,
    quota: SELF_GRANT_PER_IP,
  });
  if (!claimed) {
    observeSignup(env, "rate_limited");
    observeError(env, "rate_limited");
    return errorJson(build, 429, "rate_limited", store);
  }

  observeSignup(env, "ok");
  return jsonResponse(build, 200, { ok: true, join_grant, max_daemons: SELF_GRANT_MAX_DAEMONS }, store);
}
