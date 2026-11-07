import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/client";
import { applyCapabilities } from "../operations/capabilities-store";
import { attachLiveSession, setCredential } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { setPhase } from "../connection/connection-store";
import { paneTermMode, setPaneTermMode } from "../settings/preferences-store";
import { leaveAgentChat } from "./chat/agent-chat-controller";
import { selectPaneTermMode } from "./term-mode";
import { isAgentChat, resetPaneView, selectPane } from "./session-store";

let savedMatchMedia: typeof window.matchMedia;
let savedTouch: PropertyDescriptor | undefined;

beforeEach(async () => {
  await resetTestDOM();
  savedMatchMedia = window.matchMedia;
  savedTouch = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
  // A phone: touch, coarse pointer, narrower than the desk layout.
  Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
  window.matchMedia = ((query: string) => ({ matches: query === "(pointer: coarse)" })) as unknown as typeof window.matchMedia;
  resetPaneView();
  setPhase("live");
  setCredential(null);
  selectPane("p1");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, history: true }, []);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/x", agent: "codex", agent_status: "idle", history_available: true }],
  });
  attachLiveSession({
    isConnected: () => true,
    agentTrace: async () => ({ items: [{ type: "user", text: "Q" }], nextCursor: null, truncated: false }),
  } as unknown as LiveSession);
});
afterEach(() => {
  leaveAgentChat({ paint: false, rememberGuided: false });
  attachLiveSession(null);
  selectPane("");
  window.matchMedia = savedMatchMedia;
  if (savedTouch) Object.defineProperty(navigator, "maxTouchPoints", savedTouch);
  else delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
});

test("choosing auto in the pane menu leaves auto stored", async () => {
  setPaneTermMode("p1", "guided");
  await selectPaneTermMode("auto");
  expect(isAgentChat()).toBeTrue();
  expect(paneTermMode("p1")).toBe("auto");
});
