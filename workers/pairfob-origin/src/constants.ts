export const PROTOCOL = 2;
export const SUBPROTOCOL = "pairfob.v2";
export const BUILD_DEFAULT = "dev";

export const GRANT_ID_RE = /^g_[0-9a-f]{16}$/;
export const DAEMON_ID_RE = /^d_[0-9a-f]{20}$/;
export const RECONNECT_TOKEN_RE = /^rt_[0-9a-f]{32}$/;
export const PAIR_REF_RE = /^[0-9a-f]{32}$/;
export const TICKET_RE = /^[0-9a-f]{32}$/;

export const HELLO_GRACE_MS = 5_000;
export const RESUME_MS = 15_000;
export const PAIR_FIRST_MS = 15_000;
export const PAIR_CONFIRM_MS = 30_000;
export const TICKET_MS = 15_000;
export const DEFAULT_TTL_MS = 180_000;
export const MIN_TTL_S = 60;
export const MAX_TTL_S = 300;
export const MAX_ESTABLISHED = 10;
export const MAX_RESUME = 2;
export const MAX_PENDING_HELLO = 8;
export const FWD_FLUSH_BYTES = 65_536;
export const LOC_MINT_TRIES = 8;

export const OPEN_ENROLL_MAX_DAEMONS = 1;
export const SELF_GRANT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SELF_GRANT_PER_IP = 3;

export const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests;";

/** The marketing page has no Wasm and therefore gets the stricter script policy. */
export const CSP_SITE =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests;";
