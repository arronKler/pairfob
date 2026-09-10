import { afterEach, beforeEach, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../test-support/workspace-snapshot-restore";
import { appRoot } from "./dom-root";
import { batch } from "../shared/model/domain-store";
import { flushDirtyDomains } from "./domain-publication";
import { resetComposeDrafts, switchComposeView, bumpViewIncarnation } from "../features/session/drafts/compose-drafts";
import { bindSessionOwnerFromLive, sessionOwner } from "../features/session";
import { chatDetailChoice, chatDetailsOwner, recordChatDetailChoice } from "../features/session/chat/details";
import { registerSessionView } from "../features/session/register";
import { openPane } from "../features/connection/controller";
import { writeStoredDraft } from "../features/session/drafts/state-drafts";
import { setPhase, setNetworkOnline } from "../features/connection/connection-store";
import { applyRuntimeIdentity, runtimeStore } from "../features/connection/runtime-store";
import { setScreen } from "./navigation-store";
import { attachLiveSession, liveSession, currentDaemonId, setCredential } from "../features/computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../features/dashboard/catalog-store";
import { selectPane, setAgentChat, setFullTerminal, openPaneId, isAgentChat } from "../features/session/session-store";
import { setComposeDraft, composeDraft, setComposeIME, setComposeFocused } from "../features/session/compose-store";
import { setOperationBusy, applyCapabilities } from "../features/operations/capabilities-store";
import { applyTrace, setTraceBusy, setTraceLoadState, resetTrace } from "../features/session/chat/trace-store";
import { setPaneTermMode, setListGroup, listGroup, LIST_GROUP_KEY, listGroupCollapsed, setListGroupCollapsed, resetHerdPresentationChoices } from "../features/settings/preferences-store";
import { resetHerdAttention } from "../lib/herd-attention";
import { NO_OPERATION_CAPABILITIES } from "../lib/operations";
import type { LiveSession } from "../lib/protocol/client";
import { registerSessionOwnerPreparer } from "./frame";
import { AgentChatPane } from "../features/session/chat/agent-chat";
import { DeskShell } from "../app/layout/desk";
import { SessionPane } from "../features/session/guided/session-pane";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../lib/i18n";
import { type ListGroup } from "../lib/ranking";

function live() {
  return {
    isConnected: () => true,
    agentTrace: async () => ({ items: [], nextCursor: null, truncated: false }),
    sendKeys: async () => undefined,
    promptAgent: async () => ({ outcome: "applied" }),
  };
}

function field(): HTMLTextAreaElement | null {
  return appRoot().querySelector(".agent-dock textarea");
}

function bootDesktopChat(): void {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  batch(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    attachLiveSession(live() as LiveSession);
    setAgentChat(true);
    setFullTerminal(false);
    setNetworkOnline(true);
    setComposeDraft("First draft");
    setComposeIME(false);
    setComposeFocused(false);
    setOperationBusy(false);
    setTraceLoadState("ready");
    setTraceBusy(false);
    applyTrace({ agentTraceItems: [{ type: "user", text: "Q" }, { type: "assistant", text: "A" }], agentTraceTail: 2 });
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true, history: true }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "p1", cwd: "/tmp/review" }, { workspace_id: "w2", label: "p2", cwd: "/tmp/review" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "p1" }],
      panes: ["p1", "p2"].map((paneId) => ({
        pane_id: paneId, workspace_id: "w1", tab_id: "t1", cwd: "/tmp/review",
        agent: "codex", agent_status: "idle" as const,
      })),
    });
  });
  flushDirtyDomains();
  mountTestApp();
  commitTest();
}

// The seed projections/pruners and this suite's own boot also rewrite foreign
// dashboard/board projections, pane term modes / compose raw, listGroup and
// runtime identity. Capture once per case before ANY seed/boot and restore after
// own teardown (never re-captured inside a boot).
const foreign = new WorkspaceSnapshotRestorer();
let foreignGroup: ListGroup = "flat";
let foreignGroupRaw: string | null = null;
let foreignCollapsed: Record<string, boolean> = {};
let foreignHost = "";
let foreignKind = "";
let foreignCaptured = false;
function captureForeignExtras(): void {
  if (foreignCaptured) return;
  foreignCaptured = true;
  foreignGroup = listGroup();
  foreignGroupRaw = localStorage.getItem(LIST_GROUP_KEY);
  foreignCollapsed = listGroupCollapsed();
  foreignHost = runtimeStore.get().herdHost;
  foreignKind = runtimeStore.get().runtimeKind;
}
function restoreForeignExtras(): void {
  if (!foreignCaptured) return;
  applyRuntimeIdentity({ herdHost: foreignHost, runtimeKind: foreignKind });
  setListGroup(foreignGroup);
  if (foreignGroupRaw === null) localStorage.removeItem(LIST_GROUP_KEY);
  else localStorage.setItem(LIST_GROUP_KEY, foreignGroupRaw);
  setListGroupCollapsed(foreignCollapsed);
  foreignCaptured = false;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetComposeDrafts();
  resetHerdAttention();
  foreign.capture();
  captureForeignExtras();
  // Production bootstrap registers the session feature's owner adoption on the
  // frame seam before mounting; this suite drives the same mounted-app path.
  registerSessionOwnerPreparer(registerSessionView);
  bootDesktopChat();
});

afterEach(async () => {
  unmountTestApp();
  registerSessionOwnerPreparer(null);
  attachLiveSession(null);
  setComposeIME(false);
  setComposeFocused(false);
  setAgentChat(false);
  setScreen("home");
  resetTrace();
  setComposeDraft("");
  resetComposeDrafts();
  resetHerdPresentationChoices();
  foreign.restore();
  restoreForeignExtras();
});

test("desktop App agent chat binds owner before the keyed composer", async () => {
  expect(window.matchMedia("(min-width: 900px)").matches).toBeTrue();
  expect(appRoot().querySelector(".rail")).not.toBeNull();
  expect(appRoot().querySelector(".main [data-react-agent-chat]")?.getAttribute("data-back")).toBe("0");
  expect(sessionOwner().paneId).toBe("p1");
  expect(sessionOwner().session).toBe(liveSession());
  expect(field()?.value).toBe("First draft");
});

test.each(["pane", "session", "incarnation"] as const)(
  "desktop App retires the chat field on %s owner change",
  async (kind) => {
    const previous = field();
    expect(previous).toBeTruthy();
    const previousKey = sessionOwner().key;
    await act(async () => {
      if (kind === "pane") switchComposeView(() => { selectPane("p2"); });
      else if (kind === "session") attachLiveSession(live() as LiveSession);
      else bumpViewIncarnation();
      setComposeDraft("Second draft");
      commitTest();
    });
    expect(sessionOwner().key).not.toBe(previousKey);
    expect(field() === previous).toBeFalse();
    expect(field()?.value).toBe("Second draft");
    if (kind === "pane") expect(sessionOwner().paneId).toBe("p2");
  },
);

test("desktop production openPane(p2) restores the destination composer field", async () => {
  await act(async () => {
    setPaneTermMode("p1", "agent");
    setPaneTermMode("p2", "agent");
    writeStoredDraft(
      { daemonId: currentDaemonId(), paneId: "p2", mode: "agent" },
      { text: "Second draft" },
    );
  });
  const previous = field();
  expect(previous?.value).toBe("First draft");
  await act(async () => { openPane("p2"); await new Promise<void>((r) => setTimeout(r, 0)); });
  expect(openPaneId()).toBe("p2");
  expect(isAgentChat()).toBeTrue();
  expect(sessionOwner().paneId).toBe("p2");
  expect(field() === previous).toBeFalse();
  expect(composeDraft()).toBe("Second draft");
  expect(field()?.value).toBe("Second draft");
});

const handlers = { onBack() {}, onWorkspace() {}, onMenu() {}, onSwitch() {} };

test("StrictMode render of chat/guided/desk does not adopt or reset owner details", async () => {
  // This is a render-only boundary: the actual App that beforeEach mounted must
  // be torn down first so no frame preparation, owner binding or mounted-App
  // commit runs for this case. React renders alone — including StrictMode's
  // double render — must not adopt or reset owner details.
  await unmountTestApp();
  registerSessionOwnerPreparer(null);
  const bound = bindSessionOwnerFromLive();
  expect(recordChatDetailChoice("same-tool", true, bound.key)).toBeTrue();
  const owner = sessionOwner();
  const container = document.createElement("div");
  document.body.append(container);
  const renderRoot: Root = createRoot(container);
  await act(async () => {
    renderRoot.render(
      <StrictMode>
        <DeskShell deskPage={null}>
          <AgentChatPane includeBack={false} handlers={handlers} />
        </DeskShell>
      </StrictMode>,
    );
  });
  expect(sessionOwner()).toBe(owner);
  expect(sessionOwner().key).toBe(bound.key);
  expect(sessionOwner().paneId).toBe("p1");
  expect(chatDetailsOwner()).toBe(bound.key);
  expect(chatDetailChoice("same-tool")).toBeTrue();
  await act(async () => {
    renderRoot.render(
      <StrictMode>
        <SessionPane includeBack={false} handlers={handlers} scroll={{ top: 0, left: 0, bottom: true }} />
      </StrictMode>,
    );
  });
  expect(sessionOwner()).toBe(owner);
  expect(chatDetailsOwner()).toBe(bound.key);
  expect(chatDetailChoice("same-tool")).toBeTrue();
  act(() => { renderRoot.unmount(); container.remove(); });
});