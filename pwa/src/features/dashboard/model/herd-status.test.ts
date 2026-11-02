import { resetBoardTestDOM } from "../../../../test-support/dom";
import { beforeEach, describe, expect, test } from "bun:test";
import type { LiveSession } from "../../../lib/protocol/session-types";
import type { ConnectionPhase } from "../../../lib/connection-phase";
import { setLang, t } from "../../../lib/i18n";
import { attachLiveSession } from "../../computers/catalog-store";
import { setNetworkOnline } from "../../connection/connection-store";
import { applyRuntimeIdentity } from "../../connection/runtime-store";
import { herdStatus } from "../../connection/runtime-status";
import { herdLivenessModel, herdStatusModel } from "./herd-status";

function reachability(overrides: { phase?: ConnectionPhase; networkOnline?: boolean; runtimeKind?: string; herdHost?: string } = {}) {
  const phase = overrides.phase ?? "connected";
  const networkOnline = overrides.networkOnline ?? true;
  const runtimeKind = overrides.runtimeKind ?? "herdr";
  const herdHost = overrides.herdHost ?? "";
  return { phase, networkOnline, runtimeKind, herdHost };
}

/**
 * The connected adapter that reads the current session, driven through named
 * domain actions (no compatibility facade, no manual publish).
 */
function legacyStatus(input: ReturnType<typeof reachability>) {
  setNetworkOnline(input.networkOnline);
  applyRuntimeIdentity({ herdHost: input.herdHost, runtimeKind: input.runtimeKind });
  attachLiveSession({
    isConnected: () => input.phase === "connected",
    isChecking: () => input.phase === "verifying" || input.phase === "connecting",
    connectionPhase: () => input.phase,
  } as LiveSession);
  return herdStatus();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

describe("herd status projection", () => {
  test("loss of contact is a warning, never process death", () => {
    expect(herdLivenessModel({ connected: true, networkOnline: true, runtimeKind: "herdr" })).toBe("live");
    expect(herdLivenessModel({ connected: false, networkOnline: true, runtimeKind: "herdr" })).toBe("unverifiable");
    expect(herdLivenessModel({ connected: true, networkOnline: false, runtimeKind: "herdr" })).toBe("unverifiable");
    expect(herdLivenessModel({ connected: true, networkOnline: true, runtimeKind: "" })).toBe("unverifiable");
    expect(herdLivenessModel({ connected: true, networkOnline: true, runtimeKind: "offline" })).toBe("exited");
    expect(herdLivenessModel({ connected: true, networkOnline: true, runtimeKind: "fake" })).toBe("live");
  });

  test("every branch agrees with the connected adapter it is the pure model for", () => {
    const cases = [
      reachability({ networkOnline: false }),
      reachability({ phase: "disconnected" }),
      reachability({ phase: "verifying" }),
      reachability({ phase: "connecting" }),
      reachability({ runtimeKind: "" }),
      reachability({ runtimeKind: "offline" }),
      reachability({ runtimeKind: "fake" }),
      reachability({ herdHost: "macbook" }),
      reachability(),
    ];
    for (const input of cases) {
      const liveness = herdLivenessModel({
        connected: input.phase === "connected",
        networkOnline: input.networkOnline,
        runtimeKind: input.runtimeKind,
      });
      expect({ ...herdStatusModel({ ...input, liveness }), liveness }).toEqual({ ...legacyStatus(input), liveness });
    }
  });

  test("the copy follows the verdict", () => {
    expect(herdStatusModel(reachability({ networkOnline: false }))).toEqual({ tone: "warn", text: t("chrome.networkOffline") });
    expect(herdStatusModel(reachability({ phase: "verifying", networkOnline: false }))).toEqual({ tone: "warn", text: t("chrome.networkOffline") });
    expect(herdStatusModel(reachability({ phase: "verifying" }))).toEqual({ tone: "pending", text: t("chrome.verifying") });
    expect(herdStatusModel(reachability({ phase: "connecting" }))).toEqual({ tone: "pending", text: t("chrome.checking") });
    expect(herdStatusModel(reachability({ phase: "disconnected" }))).toEqual({ tone: "warn", text: t("chrome.reconnecting") });
    expect(herdStatusModel(reachability({ runtimeKind: "" }))).toEqual({ tone: "warn", text: t("chrome.unverifiable") });
    expect(herdStatusModel(reachability({ runtimeKind: "offline" }))).toEqual({ tone: "off", text: t("chrome.herdrOff") });
    expect(herdStatusModel(reachability({ runtimeKind: "fake" }))).toEqual({ tone: "demo", text: t("chrome.demo") });
    expect(herdStatusModel(reachability({ herdHost: "macbook" })))
      .toEqual({ tone: "live", text: t("chrome.connectedHost", { host: "macbook" }) });
    expect(herdStatusModel(reachability())).toEqual({ tone: "live", text: t("chrome.connected") });
  });
});
