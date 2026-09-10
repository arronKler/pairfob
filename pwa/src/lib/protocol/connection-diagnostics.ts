/** Browser-local, bounded connection evidence. No messages, URLs, SDP or RPC payloads. */
export type ConnectionDetails = {
  reason?: string;
  ice_state?: string;
  peer_state?: string;
  channel_state?: string;
  buffered_bytes?: number;
  ws_code?: number;
  ws_clean?: boolean;
};
export type ConnectionDiagnostic = ConnectionDetails & {
  at: number;
  event: string;
  route_id?: string;
  pwa_asset?: string;
  transport?: string;
  code?: string;
  hidden?: boolean;
  pending_rpcs?: number;
  pong_wait_ms?: number;
};
const KEY = "pairfob.connection-diagnostics.v1";
const LIMIT = 200;
const TTL = 24 * 60 * 60 * 1000;
const TOKENS = new Set((
  "transport_closed session_open session_close disconnect page_hidden page_visible probe_start probe_success probe_failed " +
  "local_close transport_upgrade foreground probe path foreground_probe_failed path_probe_failed " +
  "data_channel_closed data_channel_error send_queue_full send_failed send_not_open ice_failed ice_grace_expired " +
  "websocket_closed websocket_error heartbeat_send_failed encrypted_send_failed " +
  "relay p2p new checking connected completed disconnected failed closed connecting open closing " +
  "heartbeat_timeout timeout cancelled offline daemon_replaced bad_frame bad_message backpressure " +
  "kicked revoked expired denied not_ready closed ws_open_failed wrong_protocol error other"
).split(" "));
// Vite's immutable bundle name identifies the executing PWA, including records
// kept across a refresh onto a newer release. Never persist the full module URL.
const asset = import.meta.url.split("/").at(-1) || "";
const assetPattern = /^index-[A-Za-z0-9_-]{8,32}\.js$/;
const pwaAsset = assetPattern.test(asset) ? asset : undefined;
let records: ConnectionDiagnostic[] = [];
let loaded = false;

// Project both new records and persisted input onto the same content-free schema.
function sanitize(input: unknown, now: number): ConnectionDiagnostic | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  if (typeof source.at !== "number" || !Number.isFinite(source.at) || source.at < now - TTL || source.at > now + 60_000) return null;
  const out: Record<string, unknown> = { at: source.at };
  for (const key of ["event", "reason", "transport", "code", "ice_state", "peer_state", "channel_state"]) {
    if (typeof source[key] === "string") out[key] = TOKENS.has(source[key]) ? source[key] : "other";
  }
  if (!out.event) return null;
  if (typeof source.pwa_asset === "string" && assetPattern.test(source.pwa_asset)) out.pwa_asset = source.pwa_asset;
  if (typeof source.route_id === "string" && /^[a-f0-9]{32}$/.test(source.route_id)) out.route_id = source.route_id;
  for (const key of ["buffered_bytes", "ws_code", "pending_rpcs", "pong_wait_ms"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.round(value);
  }
  for (const key of ["hidden", "ws_clean"]) if (typeof source[key] === "boolean") out[key] = source[key];
  return out as ConnectionDiagnostic;
}

export function connectionDiagnostics(): ConnectionDiagnostic[] {
  const now = Date.now();
  if (!loaded) {
    loaded = true;
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) || "[]");
      if (Array.isArray(raw)) records = raw.slice(-LIMIT).map((item) => sanitize(item, now)).filter((item): item is ConnectionDiagnostic => item !== null);
    } catch { /* Memory-only diagnostics when storage is unavailable. */ }
  }
  records = records.filter((record) => record.at >= now - TTL).slice(-LIMIT);
  return records.map((record) => ({ ...record }));
}

export function recordConnectionDiagnostic(input: Omit<ConnectionDiagnostic, "at">): void {
  connectionDiagnostics();
  const record = sanitize({ ...input, pwa_asset: pwaAsset, at: Date.now() }, Date.now());
  if (!record) return;
  records.push(record);
  records = records.slice(-LIMIT);
  try { sessionStorage.setItem(KEY, JSON.stringify(records)); } catch { /* Best effort; never affect connection recovery. */ }
}
