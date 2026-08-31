import { t } from "./i18n.ts";
import { ProtocolError } from "./protocol/errors.ts";
import type { MuxProtocol } from "./protocol/mux.ts";
import { fetchWithTimeout, type FetchLike } from "./request-timeout.ts";

export type { MuxProtocol };
export type OriginConfig = { protocol: MuxProtocol; build: string };

export function parseOriginConfig(value: unknown): OriginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("bad_message", t("err.originShape"));
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== 2) {
    throw new ProtocolError("bad_message", t("err.originVersion"));
  }
  if (typeof record.build !== "string") {
    throw new ProtocolError("bad_message", t("err.originBuild"));
  }
  return { protocol: record.protocol, build: record.build };
}

export async function loadOriginConfig(fetchImpl: FetchLike = fetch): Promise<OriginConfig> {
  const response = await fetchWithTimeout(fetchImpl, "/api/config", { cache: "no-store" });
  if (!response.ok) throw new ProtocolError("bad_relay", t("err.originRead"));
  return parseOriginConfig(await response.json());
}

/** Same-origin PWA WS. Origin config is pairfob.v2 only; never `/v1/ws`. */
export function clientWsURL(
  protocol: MuxProtocol,
  site: { protocol: string; host: string },
  query?: { daemonId?: string; pairTicket?: string },
): string {
  if (protocol !== 2) {
    throw new ProtocolError("bad_message", t("err.originVersion"));
  }
  const scheme = site.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${scheme}://${site.host}/v2/ws`);
  url.searchParams.set("role", "client");
  if (query?.daemonId) url.searchParams.set("daemon_id", query.daemonId);
  if (query?.pairTicket) url.searchParams.set("pair_ticket", query.pairTicket);
  return url.toString();
}
