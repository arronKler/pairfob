import { resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachLiveSession } from "../../features/computers/catalog-store";
import {
  applyOriginConfig, noteRelayRtt, setNetworkMode, setNetworkOnline, setSessionTransport,
} from "../../features/connection/connection-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { hostBrief, STATUS_JOIN, type HerdStatus } from "../../features/dashboard/model/herd-view";
import { setLang, t } from "../../lib/i18n";
import type { LiveSession } from "../../lib/protocol/session-types";
import { readHerdHost } from "./herd-bridge";

/**
 * The list's title: the whole sentence for the phone header, and the same
 * status cut into parts for the rail's head, which shows as many as fit.
 */

const live: HerdStatus = { tone: "live", text: "" };

function connection(input: { transport: "relay" | "p2p"; rtt: number | null; mode?: "auto" | "p2p" | "relay" }): void {
  applyOriginConfig({ protocol: 2, p2p: true });
  setNetworkMode(input.mode ?? "auto");
  setSessionTransport(input.transport);
  noteRelayRtt(input.rtt);
}

function session(connected: boolean): void {
  attachLiveSession({ isConnected: () => connected } as unknown as LiveSession);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  setNetworkOnline(true);
  applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
  session(true);
});

afterEach(() => {
  attachLiveSession(null);
  applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
  setNetworkOnline(true);
  setNetworkMode("auto");
  setSessionTransport("relay");
  noteRelayRtt(null);
  applyOriginConfig({ protocol: 2, p2p: false });
});

describe("the computer title's status", () => {
  test("connected: the phone reads the sentence, the rail the path and its latency", () => {
    for (const lang of ["zh", "en"] as const) {
      setLang(lang);
      connection({ transport: "p2p", rtt: 18 });
      const host = readHerdHost(live);
      expect(host.line).toBe(`${t("chrome.connected")}${STATUS_JOIN}${t("settings.networkRttP2P", { ms: 18 })}`);
      // The dot already says connected; the latency is one part, number and unit together.
      const [path, latency] = t("settings.networkRttP2P", { ms: 18 }).split(STATUS_JOIN);
      expect(hostBrief(host)).toEqual([path, latency]);
      expect(latency).toMatch(/^18 \S+$/);
    }
  });

  test("the rail names the path in use before the preference it fell back from", () => {
    connection({ transport: "relay", rtt: 42, mode: "p2p" });
    const host = readHerdHost(live);
    expect(host.line).toContain(t("settings.networkP2PRelay", { ms: 42 }));
    expect(hostBrief(host)).toEqual(t("settings.networkRttRelay", { ms: 42 }).split(STATUS_JOIN));
  });

  test("a latency not measured yet is a whole part too", () => {
    connection({ transport: "relay", rtt: null });
    expect(hostBrief(readHerdHost(live))).toEqual(t("settings.networkRelayPending").split(STATUS_JOIN));
  });

  test("trouble keeps its sentence on the phone and a short form that fits the rail", () => {
    for (const lang of ["zh", "en"] as const) {
      setLang(lang);
      const off = readHerdHost({ tone: "off", text: t("chrome.herdrOff") });
      expect(off.line).toBe(`${t("chrome.herdrOff")}${STATUS_JOIN}${t("host.retryShort")}`);
      expect(hostBrief(off)).toEqual([t("rail.herdrOff"), t("host.retryShort")]);

      session(false);
      const dropped = readHerdHost({ tone: "warn", text: t("chrome.reconnecting") });
      expect(dropped.line).toBe(t("chrome.reconnecting"));
      expect(hostBrief(dropped)).toEqual([t("rail.reconnecting")]);
      session(true);
    }
  });

  test("still reading: the rail leads with what is happening, not with \"connected\"", () => {
    const host = readHerdHost({ tone: "pending", text: t("chrome.reading") });
    expect(host.line).toBe(t("chrome.reading"));
    expect(hostBrief(host)).toEqual(t("chrome.reading").split(STATUS_JOIN).slice(1));
  });

  test("offline and unconfirmed states give the rail their own parts, the cause first", () => {
    setNetworkOnline(false);
    expect(hostBrief(readHerdHost({ tone: "warn", text: t("chrome.networkOffline") })))
      .toEqual(t("chrome.networkOffline").split(STATUS_JOIN));
    setNetworkOnline(true);
    const unverified = readHerdHost({ tone: "warn", text: t("chrome.unverifiable") });
    expect(unverified.line).toBe(t("host.unverifiedLine"));
    expect(hostBrief(unverified)).toEqual(t("host.unverifiedLine").split(STATUS_JOIN));
  });
});
