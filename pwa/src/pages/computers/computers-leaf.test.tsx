import { resetTestDOM } from "../../../test-support/boot-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PairResult } from "../../lib/protocol/client";
import { setLang } from "../../lib/i18n";
import { computersStore, setComputers, setCredential, attachLiveSession } from "../../features/computers/catalog-store";
import { setPhase } from "../../features/connection/connection-store";
import { ComputersContent, ComputersScreen } from "./computers-page";

/**
 * Computers picker leaf components on a private owned root. Setup writes named
 * typed domain actions; the components subscribe to the stores. No global app
 * root, state facade, paint helper or renderer wrapper — each render owns its
 * root and unmounts after assertions.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
function unmount(): void {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
}

beforeEach(async () => {
  await resetTestDOM();
  setLang("zh");
});

afterEach(() => {
  unmount();
  setLang("zh");
  act(() => {
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    setPhase("boot");
  });
});

function sampleComputer(id: string, hostname: string): PairResult {
  return {
    deviceId: "dev_abcdefgh",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: id,
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "iPhone",
    createdAt: 1_700_000_000_000,
    hostname,
    lastSeen: 1_700_000_000_000,
  } as PairResult;
}

describe("computer picker (private root)", () => {
  test("the add action is a list row in the multi-machine picker", () => {
    act(() => {
      setComputers([sampleComputer("d_0123456789abcdef0123", "desk"), sampleComputer("d_abcdef0123456789abcd", "studio")]);
      setPhase("pick");
    });
    const el = render(createElement(ComputersScreen));
    const add = el.querySelector(".computer-add");
    expect(add).toBeInstanceOf(HTMLButtonElement);
    expect(add?.classList.contains("switch-item")).toBe(true);
    expect(add?.classList.contains("btn-ghost")).toBe(false);
    expect(add?.querySelector(".add-mark")).toBeTruthy();
    expect(add?.querySelector(".switch-name")?.textContent).toBe("添加另一台电脑");
    expect(add?.querySelector(".switch-meta")?.textContent).toBe(
      "先装 pairfob 再执行 pairfob pair。只是多一条凭证，不会替换现在这台。",
    );
    expect(el.querySelector(".computer-add + .lede")).toBeNull();
    expect(el.querySelectorAll(".computer-row")).toHaveLength(2);
    expect(el.querySelector(".prelude-title")?.textContent).toBe("选择电脑");
    expect(el.querySelector("h1.prelude-title")).toBeTruthy();
    // Pick phase (no live session) shows no settings-page chrome.
    expect(el.querySelector(".page.settings-page")).toBeNull();
    expect(el.querySelector(".computer-forget")?.getAttribute("aria-label")).toContain("desk");
    // The picker footer carries the manual update help even without a session.
    expect(el.textContent).toContain("pairfob update");
  });

  test("english keeps the add title and hint on the same row", () => {
    setLang("en");
    act(() => {
      setComputers([sampleComputer("d_0123456789abcdef0123", "desk"), sampleComputer("d_abcdef0123456789abcd", "studio")]);
      setPhase("pick");
    });
    const el = render(createElement(ComputersScreen));
    const add = el.querySelector(".computer-add");
    expect(add?.querySelector(".switch-name")?.textContent).toBe("Add another computer");
    expect(add?.querySelector(".switch-meta")?.textContent).toBe(
      "Install pairfob, then run pairfob pair. This adds a credential; it does not replace this one.",
    );
  });

  test("one stored computer is an offline retry with no topbar for bare content", () => {
    act(() => {
      setComputers([sampleComputer("d_0123456789abcdef0123", "desk")]);
      setPhase("pick");
    });
    const el = render(createElement(ComputersContent, { withBack: false }));
    expect(el.querySelector(".prelude-title")?.textContent).toBe("连不上电脑");
    expect(el.querySelector(".lede")?.textContent).toContain("电脑现在不在线");
    expect(el.querySelector(".topbar")).toBeNull();
  });

  test("a live session uses the settings page chrome and a back bar", () => {
    act(() => {
      setComputers([sampleComputer("d_0123456789abcdef0123", "desk")]);
      setCredential(sampleComputer("d_0123456789abcdef0123", "desk"));
      attachLiveSession({ isConnected: () => true } as never);
      setPhase("live");
    });
    const el = render(createElement(ComputersScreen));
    expect(el.querySelector(".page.settings-page")).toBeTruthy();
    expect(el.querySelector(".topbar-title")?.textContent).toBe("电脑");
    expect(el.querySelector(".prelude-title")).toBeNull();
    expect(el.querySelector("details.set-card")).toBeNull();
  });
});
