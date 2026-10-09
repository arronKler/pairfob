import { expectSameNode } from "../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { compile } from "sass";
import { fileURLToPath } from "node:url";
import type { PairResult } from "../../lib/protocol/client";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { commitView } from "../../app/host";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { setScreen } from "../../app/navigation-store";
import { clearNotice } from "../../app/notices-store";
import { resetTransitionState } from "../../app/transition";
import { attachLiveSession, setAddingComputer, setComputers, setCredential } from "../../features/computers/catalog-store";
import { setConnectionRecordSource } from "../../features/connection/connection-path";
import { setConnectFailure, setPhase, setRetryingUnreachable } from "../../features/connection/connection-store";
import { stopPolling } from "../../features/connection/controller";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { registerSessionView } from "../../features/session/register";
import { setLang, t } from "../../lib/i18n";

/**
 * The "only computer cannot be reached" page beside the list: a desktop window
 * or a tablet, against the actual mounted App. The rail keeps its frame with
 * nothing live in it, the explanation is the main column's page, both stay
 * while the page's own retry is in flight, and the device-side steps are
 * worded for a computer when a mouse points.
 * The page's own clock and the phone frame are `boot-shell.test`.
 */

const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const realMatchMedia = happy.matchMedia;

/** Happy DOM always reports a mouse; a tablet is the same window with a finger. */
function setPointer(fine: boolean): void {
  const answer = (query: string) => query === FINE_POINTER
    ? { matches: fine, media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList
    : realMatchMedia.call(happy, query);
  (happy as unknown as { matchMedia: typeof answer }).matchMedia = answer;
  (globalThis as unknown as { matchMedia: typeof answer }).matchMedia = answer;
}

function computer(): PairResult {
  return {
    deviceId: "dev_abcdefgh", psk: new Uint8Array(32), daemonPk: new Uint8Array(32), daemonId: "d_aaaaaaaaaaaaaaaaaaaa",
    fp: "0".repeat(16), relayOrigin: "https://pairfob.com", label: "Chrome", createdAt: 1, hostname: "Studio", lastSeen: 0,
  };
}

/** The last attempt never reached pairfob.com, or reached it and then failed. */
function recordAttempt(reachedRelay: boolean): void {
  const started = Date.now() - 12_000;
  setConnectionRecordSource(() => [{ event: "connect_start", at: started },
    ...(reachedRelay ? [{ event: "ws_open", at: started + 400 }] : []), { event: "connect_failed", at: started + 8_000 }]);
}

async function mount(): Promise<HTMLElement> {
  act(() => {
    mountApp();
    commitView();
  });
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  return appRoot();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  registerSessionOwnerPreparer(registerSessionView);
  resetTransitionState();
  setLang("zh");
  recordAttempt(true);
  act(() => {
    batch(() => {
      setComputers([computer()]);
      setCredential(null);
      setAddingComputer(false);
      setConnectFailure("daemon_offline");
      setRetryingUnreachable(false);
      setScreen("home");
      setPhase("pick");
      clearNotice();
    });
  });
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    resetTransitionState();
    clearNotice();
    setConnectFailure("");
    setRetryingUnreachable(false);
    setAddingComputer(false);
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    resetDashboard();
    setPhase("boot");
    setScreen("home");
  });
  setConnectionRecordSource(null);
  (happy as unknown as { matchMedia: typeof realMatchMedia }).matchMedia = realMatchMedia;
  // The next suite's reset re-binds the global and restores the phone window.
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

const stepDetails = (app: HTMLElement) => [...app.querySelectorAll(".conn-step small")].map(node => node.textContent);

describe("the only computer cannot be reached, on a wide layout", () => {
  test("the rail keeps its frame and the main column explains, in place of the picker", async () => {
    // Rows a session left behind before the computer went away are not this page's to show.
    act(() => replaceAgentsFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: "blocked" }],
    } as never));
    const app = await mount();
    expect(app.classList.contains("desk")).toBeTrue();
    expect(app.classList.contains("tabs")).toBeFalse();
    expect(app.classList.contains("rail-hidden")).toBeFalse();
    expect(app.querySelector(".tab-bar")).toBeNull();
    expect(app.querySelector(".computer-pick")).toBeNull();
    // The phone's page is not what sits in the main column.
    expect(app.querySelector(".unreachable-shell")).toBeNull();
    expect([...app.children].map(node => node.className)).toEqual(["rail", "main main-unreachable"]);

    const rail = app.querySelector(".rail")!;
    expect(rail.querySelector(".host-title-label")?.textContent).toBe("Studio");
    expect(rail.querySelector(".host-title")?.classList.contains("is-off")).toBeTrue();
    expect(rail.querySelector(".host-title-line")?.textContent).toContain("不在线");
    expect(rail.querySelector(".host-title")?.getAttribute("aria-haspopup")).toBe("dialog");
    // Nothing listed, nothing that looks like loading, nothing to create.
    expect(rail.querySelector(".card, .herd-skeleton, .herd-group, .attn-strip")).toBeNull();
    expect(rail.querySelector(".rail-create")).toBeNull();
    expect(rail.querySelector(".rail-list [role=status]")?.textContent).toBe(t("empty.reconnectNote"));

    const main = app.querySelector(".main-unreachable")!;
    expect(main.querySelector(".unreachable-title")?.textContent).toBe(t("unreach.deskTitle", { target: "Studio" }));
    expect([...main.querySelectorAll(".conn-node small")].map(node => node.textContent))
      .toEqual([t("path.phoneOk"), t("path.relayOk"), t("path.offline")]);
    expect([...main.querySelectorAll(".conn-step code")].map(node => node.textContent))
      .toEqual(["pairfob service status", "pairfob service restart"]);
    expect(main.querySelector<HTMLButtonElement>(".conn-retry")?.disabled).toBeFalse();
    expect(main.querySelector(".conn-retry")?.textContent).toBe(t("unreach.retryNow"));
    expect(main.querySelector(".conn-retry-note")?.textContent).toContain(t("unreach.autoRetry", { n: "15" }));
    expect(main.querySelector(".conn-retry-add")?.textContent).toBe(t("unreach.add"));
  });

  test("search, Board and Settings are in the frame but locked, as the phone's tab bar locks them", async () => {
    const app = await mount();
    const locked = [...app.querySelectorAll<HTMLButtonElement>(".rail-search, .rail-nav-item")];
    expect(locked).toHaveLength(3);
    expect(locked.every(button => button.disabled)).toBeTrue();
    expect(app.querySelector(".rail-nav-item.is-current")).toBeNull();
    act(() => locked.forEach(button => button.click()));
    expect(app.querySelector(".main-unreachable")).toBeTruthy();
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  test("the title opens this page's computer panel: retry, add another, forget", async () => {
    const app = await mount();
    act(() => app.querySelector<HTMLButtonElement>(".rail .host-title")!.click());
    expect([...document.querySelectorAll(".menu-choice-title")].map(node => node.textContent?.trim()))
      .toEqual([t("host.retry"), t("host.add"), t("unreach.forget")]);
    act(closeTestDialogs);
  });

  test("when pairfob.com is the hop that broke, the page says so and gives the device-side steps", async () => {
    recordAttempt(false);
    act(() => setConnectFailure("timeout"));
    const app = await mount();
    expect(app.querySelector(".rail .host-title-line")?.textContent).toBe(t("unreach.lineRelay"));
    expect(app.querySelector(".unreachable-title")?.textContent).toBe(t("unreach.deskTitle", { target: "pairfob.com" }));
    expect([...app.querySelectorAll(".conn-node small")].map(node => node.textContent))
      .toEqual([t("path.phoneOnline"), t("path.unreachable"), t("path.unknown")]);
    expect(app.querySelector("#conn-steps-title")?.textContent).toBe(t("unreach.onPhone"));
    // A mouse means a computer: no cellular data to switch to.
    expect(stepDetails(app)).toEqual([t("unreach.networkDetailDesk"), t("unreach.vpnDetail")]);
    expect(app.textContent).not.toContain("蜂窝");
    expect(app.querySelector(".computer-pick")).toBeNull();
  });

  test("a tablet keeps the frame at either width and the phone's wording for the same steps", async () => {
    setPointer(false);
    recordAttempt(false);
    act(() => setConnectFailure("timeout"));
    for (const width of [1180, 820]) {
      happy.happyDOM.setWindowSize({ width, height: width === 1180 ? 820 : 1180 });
      const app = await mount();
      expect(app.classList.contains("desk")).toBeTrue();
      expect(app.querySelector(".rail .host-title-label")?.textContent).toBe("Studio");
      expect(app.querySelector(".main-unreachable")).toBeTruthy();
      expect(app.querySelector(".tab-bar")).toBeNull();
      expect(stepDetails(app)).toEqual([t("unreach.networkDetail"), t("unreach.vpnDetail")]);
      act(() => unmountApp());
    }
  });

  test("its own retry keeps the same frame up instead of the boot splash", async () => {
    const app = await mount();
    const rail = app.querySelector(".rail");
    await act(async () => {
      batch(() => {
        setRetryingUnreachable(true);
        setPhase("resuming");
      });
      commitView();
    });
    expect(app.classList.contains("desk")).toBeTrue();
    expect(app.classList.contains("boot-screen")).toBeFalse();
    expect(app.querySelector(".boot")).toBeNull();
    // One tree across the attempt: the list frame does not remount.
    expectSameNode(app.querySelector(".rail"), rail);
    expect(app.querySelector<HTMLButtonElement>(".conn-retry")?.disabled).toBeTrue();
    expect(app.querySelector(".conn-retry")?.textContent).toBe(t("unreach.retrying"));
    expect([...app.querySelectorAll(".conn-node small")].map(node => node.textContent)).toContain(t("path.retrying"));
    // The attempt failed again: the same page, counting down again.
    await act(async () => {
      batch(() => {
        setRetryingUnreachable(false);
        setPhase("pick");
      });
      commitView();
    });
    expectSameNode(app.querySelector(".rail"), rail);
    expect(app.querySelector<HTMLButtonElement>(".conn-retry")?.disabled).toBeFalse();
    expect(app.querySelector(".conn-retry-note")?.textContent).toContain(t("unreach.autoRetry", { n: "15" }));
  });

  test("any other reconnect is still the splash", async () => {
    act(() => {
      batch(() => {
        setCredential(computer());
        setPhase("resuming");
      });
    });
    const app = await mount();
    expect(app.classList.contains("boot-screen")).toBeTrue();
    expect(app.classList.contains("desk")).toBeFalse();
    expect(app.querySelector(".boot .boot-text")?.textContent).toBe(t("boot.connecting", { name: "Studio" }));
    expect(app.querySelector(".rail, .main-unreachable")).toBeNull();
  });

  test("the phone frames the same explanation with its tab bar, and no rail", async () => {
    setPointer(false);
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    const app = await mount();
    expect(app.classList.contains("tabs")).toBeTrue();
    expect(app.classList.contains("desk")).toBeFalse();
    expect(app.querySelector(".page.herd-page.unreachable-shell")).toBeTruthy();
    expect(app.querySelector(".rail, .main")).toBeNull();
    expect(app.querySelector(".tab-bar")).toBeTruthy();
    expect([...app.querySelectorAll(".unreachable-shell > *")].map(node => node.className.split(" ")[0]))
      .toEqual(["sr-only", "herd-head", "conn-path-card", "conn-steps", "conn-retry-dock"]);
  });
});

describe("the wide page's styles", () => {
  const css = compile(fileURLToPath(new URL("../../style.scss", import.meta.url)), { style: "expanded" }).css
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ parts: match[1].split(",").map(part => part.trim()), body: match[2] }));
  const selectors = blocks.flatMap(block => block.parts);
  /** Every declaration that applies to one selector, grouped or alone. */
  const declared = (selector: string) => blocks.filter(block => block.parts.includes(selector)).map(block => block.body).join("\n");

  test("the main column is one centred column that scrolls by itself, set with Settings", () => {
    const page = declared(".main-unreachable");
    expect(page).toMatch(/overflow-y:\s*auto/);
    expect(page).not.toContain("--tab-bar-h");
    expect(page).not.toMatch(/position:\s*fixed/);
    const child = declared(".main-unreachable > *");
    expect(child).toMatch(/max-width:\s*40rem/);
    expect(child).toMatch(/align-self:\s*center/);
    // The same rules, not a copy that can drift.
    expect(blocks.filter(block => block.parts.includes(".main-unreachable > *"))
      .every(block => block.parts.includes(".main-settings > *"))).toBeTrue();
  });

  test("the retry follows the steps instead of sitting on the floor", () => {
    const dock = rule(".main-unreachable .conn-retry-dock");
    expect(dock).toMatch(/position:\s*static/);
    expect(dock).toMatch(/background:\s*none/);
    expect(rule(".main-unreachable .conn-retry")).toMatch(/width:\s*auto/);
  });

  test("the phone keeps its pinned retry and its floor: nothing wide names its page", () => {
    expect(rule(".conn-retry-dock")).toMatch(/position:\s*fixed/);
    expect(rule(".conn-retry-dock")).toContain("--tab-bar-h");
    expect(rule(".conn-retry")).toMatch(/width:\s*100%/);
    // The last step scrolls clear of the fixed dock.
    expect(rule("#app.tabs .page.unreachable-shell")).toMatch(/padding-bottom:[^;]*132px/);
    expect(selectors.filter(selector => selector.includes(".unreachable-shell"))).toEqual(["#app.tabs .page.unreachable-shell"]);
    // Every rule of the desk page hangs off the main column, which only the desk shell has.
    const wide = selectors.filter(selector => selector.includes("unreachable") && !selector.includes(".unreachable-shell"));
    expect(wide.length).toBeGreaterThan(5);
    for (const selector of wide) expect(selector.startsWith(".main-unreachable"), selector).toBeTrue();
  });
});
