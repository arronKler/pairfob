import { resetBoardTestDOM } from "../../../../test-support/dom";
import { beforeEach, describe, expect, test } from "bun:test";
import type { LiveSession } from "../../../lib/protocol/session-types";
import { setLang, t } from "../../../lib/i18n";
import { attachLiveSession } from "../../computers/catalog-store";
import { setNetworkOnline } from "../../connection/connection-store";
import { applyRuntimeIdentity } from "../../connection/runtime-store";
import { herdStatus } from "../../connection/runtime-status";
import { herdLivenessModel, herdStatusModel } from "./herd-status";

function reachability(overrides: { connected?: boolean; networkOnline?: boolean; runtimeKind?: string; herdHost?: string } = {}) {
  const connected = overrides.connected ?? true;
  const networkOnline = overrides.networkOnline ?? true;
  const runtimeKind = overrides.runtimeKind ?? "herdr";
  const herdHost = overrides.herdHost ?? "";
  return { connected, networkOnline, runtimeKind, herdHost };
}

/**
 * The connected adapter that reads the current session, driven through named
 * domain actions (no compatibility facade, no manual publish).
 */
function legacyStatus(input: ReturnType<typeof reachability>) {
  setNetworkOnline(input.networkOnline);
  applyRuntimeIdentity({ herdHost: input.herdHost, runtimeKind: input.runtimeKind });
  attachLiveSession((input.connected ? { isConnected: () => true } : null) as LiveSession | null);
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
      reachability({ connected: false }),
      reachability({ runtimeKind: "" }),
      reachability({ runtimeKind: "offline" }),
      reachability({ runtimeKind: "fake" }),
      reachability({ herdHost: "macbook" }),
      reachability(),
    ];
    for (const input of cases) {
      const liveness = herdLivenessModel(input);
      expect({ ...herdStatusModel({ ...input, liveness }), liveness }).toEqual({ ...legacyStatus(input), liveness });
    }
  });

  test("the copy follows the verdict", () => {
    expect(herdStatusModel(reachability({ networkOnline: false }))).toEqual({ tone: "warn", text: t("chrome.networkOffline") });
    expect(herdStatusModel(reachability({ connected: false }))).toEqual({ tone: "warn", text: t("chrome.reconnecting") });
    expect(herdStatusModel(reachability({ runtimeKind: "" }))).toEqual({ tone: "warn", text: t("chrome.unverifiable") });
    expect(herdStatusModel(reachability({ runtimeKind: "offline" }))).toEqual({ tone: "off", text: t("chrome.herdrOff") });
    expect(herdStatusModel(reachability({ runtimeKind: "fake" }))).toEqual({ tone: "demo", text: t("chrome.demo") });
    expect(herdStatusModel(reachability({ herdHost: "macbook" })))
      .toEqual({ tone: "live", text: t("chrome.connectedHost", { host: "macbook" }) });
    expect(herdStatusModel(reachability())).toEqual({ tone: "live", text: t("chrome.connected") });
  });
});
