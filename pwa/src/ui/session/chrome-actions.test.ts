import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "../react/root";

const { setRenderer } = await import("../../paint");
const { app, clearNotice, state } = await import("../../state.ts");
const { setLang, t } = await import("../../lib/i18n.ts");
const { SessionActions } = await import("../react/session-chrome.tsx");

beforeEach(async () => {
  await resetBoardTestDOM();
  act(leaveReactScreen);
  app.replaceChildren();
  setLang("zh");
  setRenderer(() => {});
  Object.assign(state, {
    phase: "live", screen: "home", paneId: "", paneText: "", paneHash: "", live: null,
    agents: [], fullTerminal: false, agentChat: false, operationBusy: false,
    composeDraft: "", composeLive: false, composeIME: false, composeFocused: false,
    defaultComposeLive: false, paneComposeLive: {}, keysExpanded: false, padKind: "keys",
    termSelect: false, termWrap: false, paneRow: null, paneFollow: true, paneUnread: false,
  });
  clearNotice();
});

afterEach(() => {
  act(() => leaveReactScreen());
  state.operationBusy = false;
  clearNotice();
  setRenderer(() => {});
  app.replaceChildren();
});

describe("workspace chrome entry", () => {
  test("is available by default before more", () => {
    act(() => renderReactScreen(createElement(SessionActions, {
      onWorkspace: () => undefined,
      onMenu: () => undefined,
      onStop: () => undefined,
      working: false,
    })));
    const cluster = app.querySelector(".chrome-actions")!;
    expect(cluster.querySelector(".icon-workspace")?.getAttribute("aria-label")).toBe(t("workspace.open"));
    expect(cluster.querySelectorAll("button")).toHaveLength(2);
    expect(cluster.firstElementChild?.classList.contains("icon-workspace")).toBeTrue();
    expect(cluster.querySelector(".icon-stop")).toBeNull();
  });
});
