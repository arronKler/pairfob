import { validDaemonId } from "./identifiers.ts";
import { ProtocolError } from "./protocol/errors.ts";
import { fetchWithTimeout, type FetchLike } from "./request-timeout.ts";

export type PairIntent = {
  daemonId: string;
  pairRef: string;
  pairTicket: string;
};

function intentErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const error = (value as { error?: { code?: unknown } }).error;
  return error && typeof error.code === "string" ? error.code : "";
}

function intentHit(value: unknown): value is { daemon_id: string; pair_ref: string; pair_ticket: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    record.v === 2 &&
    validDaemonId(record.daemon_id) &&
    typeof record.pair_ref === "string" &&
    /^[0-9a-f]{32}$/.test(record.pair_ref) &&
    typeof record.pair_ticket === "string" &&
    /^[0-9a-f]{32}$/.test(record.pair_ticket)
  );
}

/** Metered hand-entry lookup. Never sends `s`. Caller must not put `pair_loc` on the WS URL. */
export async function requestPairIntent(
  pairLoc: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<PairIntent> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, "/v2/pair-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ v: 2, pair_loc: pairLoc }),
    }, { signal });
  } catch (error) {
    if (signal?.aborted) throw new ProtocolError("pairing_cancelled", "已取消配对");
    throw error;
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = intentErrorCode(body);
  if (response.status === 404 || code === "unpaired") {
    throw new ProtocolError("unpaired", "配对码过期或已用过，请抄电脑 pairfob 打印的当前码");
  }
  if (response.status === 429 || code === "rate_limited") {
    throw new ProtocolError("rate_limited", "尝试太频繁，请稍后再试。");
  }
  if (!response.ok || !intentHit(body)) {
    throw new ProtocolError(code || "unpaired", "无法开始配对");
  }
  return { daemonId: body.daemon_id, pairRef: body.pair_ref, pairTicket: body.pair_ticket };
}
