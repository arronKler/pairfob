import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";

const { clearNotice } = await import("../../../app/notices-store.ts");
const { setOperationBusy } = await import("../../operations/capabilities-store.ts");
const { setLang, t } = await import("../../../lib/i18n.ts");
const { SessionActions } = await import("./session-chrome.tsx");

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
  setLang("zh");
  clearNotice();
  setOperationBusy(false);
});

afterEach(() => {
  unmountReact();
  setOperationBusy(false);
  clearNotice();
  appRoot().replaceChildren();
});

const handlers = (toggles: string[], chat = true) => ({
  onBack: () => undefined, onWorkspace: () => undefined, onMenu: () => undefined,
  onToggleView: () => { toggles.push("toggle"); }, chatAvailable: () => chat,
});

describe("session chrome actions", () => {
  test("an agent pane offers the chat toggle before more; files are not a header slot", () => {
    const toggles: string[] = [];
    renderReact(createElement(SessionActions, { agent: { paneId: "p1", hasAgent: true, agent: "claude" } as never, handlers: handlers(toggles) }));
    const cluster = appRoot().querySelector(".chrome-actions")!;
    expect([...cluster.querySelectorAll("button")].map((button) => button.className)).toEqual(["icon-btn icon-view", "icon-btn icon-more"]);
    expect(cluster.querySelector(".icon-view")?.getAttribute("aria-label")).toBe(t("head.toChat"));
    act(() => cluster.querySelector<HTMLButtonElement>(".icon-view")!.click());
    expect(toggles).toEqual(["toggle"]);
    expect(cluster.querySelector(".icon-workspace")).toBeNull();
    expect(cluster.querySelector(".icon-stop")).toBeNull();
  });

  test("an agent without a readable transcript keeps a disabled toggle; a shell has none", () => {
    renderReact(createElement(SessionActions, { agent: { paneId: "p1", hasAgent: true, agent: "opencode" } as never, handlers: handlers([], false) }));
    const toggle = appRoot().querySelector<HTMLButtonElement>(".icon-view")!;
    expect(toggle.disabled).toBeTrue();
    expect(toggle.getAttribute("aria-label")).toBe(t("head.chatOff"));
    renderReact(createElement(SessionActions, { agent: { paneId: "p2", hasAgent: false } as never, handlers: handlers([]) }));
    expect(appRoot().querySelectorAll(".chrome-actions button")).toHaveLength(1);
  });
});
