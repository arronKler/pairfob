import { describe, expect, test } from "bun:test";
import type { PairResult } from "../../lib/protocol/client";
import { setLang } from "../../lib/i18n";
import { computersBackTarget, computersViewModel } from "./model";

function pair(id: string, hostname: string, lastSeen = 0, createdAt = 0): PairResult {
  return {
    deviceId: "dev_abcdefgh",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: id,
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "iPhone",
    createdAt,
    hostname,
    lastSeen,
  };
}

const desk = pair("d_0123456789abcdef0123", "desk", 1_700_000_000_000, 1_700_000_000_000);
const studio = pair("d_abcdef0123456789abcd", "studio");

describe("computers view model", () => {
  test("one stored computer is an offline retry, not a multi-machine chooser", () => {
    setLang("zh");
    const view = computersViewModel({
      computers: [desk],
      credentialDaemonId: null,
      live: false,
      lastUsedDaemonId: null,
      computersFrom: "home",
      desk: false,
      paneId: "",
      withBack: false,
    });
    expect(view.heading).toEqual({ title: "连不上电脑", lede: view.heading!.lede });
    expect(view.heading?.lede).toContain("电脑现在不在线");
    expect(view.withBack).toBeFalse();
    expect(view.pageClass).toBe("page");
    expect(view.showManualUpdateHelp).toBeTrue();
  });

  test("two stored computers pick a machine and the live row carries the current pill", () => {
    setLang("zh");
    const view = computersViewModel({
      computers: [desk, studio],
      credentialDaemonId: desk.daemonId,
      live: true,
      lastUsedDaemonId: desk.daemonId,
      computersFrom: "settings",
      desk: false,
      paneId: "",
      withBack: true,
    });
    expect(view.heading).toBeNull();
    expect(view.backTitle).toBe("电脑");
    expect(view.pageClass).toBe("page settings-page");
    expect(view.rows[0]?.current).toBeTrue();
    expect(view.rows[0]?.currentPill).toBe("当前");
    expect(view.rows[0]?.meta).toBe("当前连接");
    expect(view.rows[1]?.current).toBeFalse();
    expect(view.rows[1]?.currentPill).toBeNull();
    expect(view.rows[1]?.meta).toBe("尚未连上过");
    expect(view.showManualUpdateHelp).toBeFalse();
  });

  test("back from settings stays on settings; desk with a pane returns to the pane", () => {
    expect(computersBackTarget({ computersFrom: "settings", desk: true, paneId: "p1" })).toBe("settings");
    expect(computersBackTarget({ computersFrom: "home", desk: true, paneId: "p1" })).toBe("pane");
    expect(computersBackTarget({ computersFrom: "home", desk: false, paneId: "p1" })).toBe("home");
    expect(computersBackTarget({ computersFrom: "home", desk: true, paneId: "" })).toBe("home");
  });
});
