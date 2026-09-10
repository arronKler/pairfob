import { happy, resetChatDOM } from "../../../../test-support/chat-dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import type { LiveSession } from "../../../lib/protocol/client";
import { resetComposeDrafts } from "../drafts/compose-drafts";
import { clearAgentTraceCache } from "../../../lib/agent-trace-cache";
import { setPhase } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { selectPane, setAgentChat, setFullTerminal } from "../session-store";
import { applyCapabilities, setOperationBusy } from "../../operations/capabilities-store";
import { applyTrace, setTraceBusy, setTraceLoadState, setTraceNote } from "./trace-store";
import { setComposeDraft, setComposeIME } from "../compose-store";
import { clearNotice } from "../../../app/notices-store";
import { replaceAgentsFromSnapshot } from "../../dashboard/catalog-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { AgentChatPane } from "./agent-chat";
import { renderReact, unmountReact, mountTestApp, commitTest, unmountTestApp } from "../../../../test-support/react-harness";
import * as controller from "./agent-chat-controller";

beforeEach(async () => {
  await resetChatDOM();
  setLang("zh");
  resetComposeDrafts();
  clearAgentTraceCache();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(false);
  setAgentChat(true);
  setComposeDraft("");
  setComposeIME(false);
  setOperationBusy(false);
  clearNotice();
  setTraceLoadState("ready");
  setTraceBusy(false);
  setTraceNote("");
  applyTrace({
    agentTraceItems: [{ type: "user", text: "Review this" }, { type: "assistant", text: "**Ready**" }],
    agentTracePending: "",
    agentTracePendingBase: [],
  });
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, history: true, prompt_agent: true }, []);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [
      { pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/demo", agent: "codex", agent_status: "idle", history_available: true },
    ],
  });
  attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
});
afterEach(async () => await act(async () => {
  unmountReact();
  controller.leaveAgentChat({ paint: false });
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
  setAgentChat(false);
  resetComposeDrafts();
  clearAgentTraceCache();
  unmountTestApp();
  appRoot().replaceChildren();
}));

test("the controller keeps the canonical chat surface the retired facade re-exported", () => {
  // ui/agent-chat.ts re-exported exactly these controller functions. With that
  // dead facade retired, legacy callers resolve the same names straight from
  // the real owner, so this exact surface contract is what the deletion
  // depends on: renaming or dropping one of these breaks the retirement.
  for (const key of ["canEnterAgentChat", "enterAgentChat", "leaveAgentChat", "patchAgentChat",
    "refreshAgentTrace", "restoreAgentTrace", "stickAgentStream"] as const) {
    expect(typeof controller[key]).toBe("function");
  }
});

test("the phone entry mounts the React page and forwards its chrome callbacks", () => {
  const actions: string[] = [];
  bindSessionOwnerFromLive();
  renderReact(createElement(AgentChatPane, {
    includeBack: true,
    handlers: {
      onBack: () => actions.push("back"),
      onWorkspace: () => actions.push("workspace"),
      onMenu: () => actions.push("menu"),
      onSwitch: () => actions.push("switch"),
    },
  }));
  expect(appRoot().querySelector("[data-react-agent-chat]")?.getAttribute("data-back")).toBe("1");
  expect(appRoot().querySelector(".agent-md strong")?.textContent).toBe("Ready");
  act(() => {
    for (const selector of [".back", ".icon-workspace", ".icon-more", ".chrome-title"]) {
      const button = appRoot().querySelector<HTMLButtonElement>(selector);
      if (!button) throw new Error(`Missing ${selector}`);
      button.click();
    }
  });
  expect(actions).toEqual(["back", "workspace", "menu", "switch"]);
});

test("the desktop entry hosts React chat in the main column without a pane back button", () => {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  mountTestApp();
  commitTest();
  const chat = appRoot().querySelector(".main [data-react-agent-chat]");
  expect(chat).not.toBeNull();
  expect(chat?.getAttribute("data-back")).toBe("0");
  expect(chat?.querySelector(".back")).toBeNull();
  expect(chat?.querySelector(".agent-user-text")?.textContent).toBe("Review this");
  expect(chat?.querySelector(".agent-dock textarea")).not.toBeNull();
});