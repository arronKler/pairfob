import { happy, resetChatDOM } from "../../test-support/chat-dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { app, state } from "../state";
import { setLang } from "../lib/i18n";
import { resetComposeDrafts } from "../compose-drafts";
import { clearAgentTraceCache } from "../lib/agent-trace-cache";
import * as facade from "./agent-chat";
import * as controller from "./agent-chat-controller";
import { renderDesk } from "./desk";
import { leaveReactScreen } from "./react/root";

beforeEach(async () => {
  await resetChatDOM();
  setLang("zh");
  resetComposeDrafts();
  clearAgentTraceCache();
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.agentChat = true;
  state.fullTerminal = false;
  state.composeDraft = "";
  state.composeIME = false;
  state.operationBusy = false;
  state.notice = null;
  state.agentTraceLoadState = "ready";
  state.agentTraceBusy = false;
  state.agentTraceNote = "";
  state.agentTraceItems = [{ type: "user", text: "Review this" }, { type: "assistant", text: "**Ready**" }];
  state.agentTracePending = "";
  state.agentTracePendingBase = [];
  state.operationCapabilities = { ...state.operationCapabilities, history: true, prompt_agent: true };
  state.agents = [{ paneId: "p1", agent: "codex", hasAgent: true, status: "idle",
    workspaceLabel: "demo", cwd: "/tmp/demo", historyAvailable: true }];
  state.live = { isConnected: () => true } as NonNullable<typeof state.live>;
});
afterEach(async () => await act(async () => {
  leaveReactScreen();
  controller.leaveAgentChat({ paint: false });
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  resetComposeDrafts();
  clearAgentTraceCache();
}));

test("the public chat facade exposes the canonical controller functions", () => {
  for (const key of ["canEnterAgentChat", "enterAgentChat", "leaveAgentChat", "patchAgentChat",
    "refreshAgentTrace", "restoreAgentTrace", "stickAgentStream"] as const) {
    expect(facade[key]).toBe(controller[key]);
  }
});

test("the phone facade mounts the React page and forwards its chrome callbacks", async () => await act(async () => {
  const actions: string[] = [];
  facade.renderAgentChat(() => actions.push("back"), () => actions.push("workspace"),
    () => actions.push("menu"), () => actions.push("switch"));
  expect(app.querySelector("[data-react-agent-chat]")?.getAttribute("data-back")).toBe("1");
  expect(app.querySelector(".agent-md strong")?.textContent).toBe("Ready");
  for (const selector of [".back", ".icon-workspace", ".icon-more", ".chrome-title"]) {
    const button = app.querySelector<HTMLButtonElement>(selector);
    if (!button) throw new Error(`Missing ${selector}`);
    button.click();
  }
  expect(actions).toEqual(["back", "workspace", "menu", "switch"]);
}));

test("the desktop entry hosts React chat in the main column without a pane back button", async () => await act(async () => {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  renderDesk();
  const chat = app.querySelector(".main [data-react-agent-chat]");
  expect(chat).not.toBeNull();
  expect(chat?.getAttribute("data-back")).toBe("0");
  expect(chat?.querySelector(".back")).toBeNull();
  expect(chat?.querySelector(".agent-user-text")?.textContent).toBe("Review this");
  expect(chat?.querySelector(".agent-dock textarea")).not.toBeNull();
}));
