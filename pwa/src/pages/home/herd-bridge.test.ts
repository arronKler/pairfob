import { resetBoardTestDOM, happy } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { createHerdActions } from "../../features/dashboard/actions";
import { HerdScreen } from "../../features/dashboard/components/herd-screen";
import { resetHerdAttention } from "../../lib/herd-attention";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { morphingPane, nextTransition, takeTransition } from "../../app/transition";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { attachLiveSession, setCredential } from "../../features/computers/catalog-store";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { setComputers } from "../../features/computers/catalog-store";
import {
  listGroup,
  preferencesStore,
  resetHerdPresentationChoices,
  setListGroup,
  setListGroupCollapsed,
  setTermFontPx,
  termFontPx,
  termWrap,
  setTermWrap,
  rememberPane,
  togglePanePin,
} from "../../features/settings/preferences-store";
import { applyCapabilities as setCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { boardReturn } from "../../features/board/layout-store";
import { appHost, registerAppHost, releaseAppHost, type AppHost } from "../../app/host";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { selectPane } from "../../features/session/session-store";
import {
  consumeHerdAttention,
  herdActionPorts,
  herdPreferencesKey,
  readHerdAttention,
  readHerdInput,
  resetHerdAttentionSnapshot,
  subscribeHerdAttention,
  toggleHerdGroup,
} from "./herd-bridge";
import { buildHerdViewModel, type HerdViewModel } from "../../features/dashboard/model/herd-view";

/**
 * One paint, then the list as the route projects it. The paint boundary itself
 * projects nothing: the view these assertions read is the one a render builds
 * from the published domains.
 */
function presentHerdView(): HerdViewModel {
  consumeHerdAttention();
  return buildHerdViewModel(readHerdInput(readHerdAttention()));
}

const vibrations: number[] = [];
let hostCommitted = 0;
let hostRequested = 0;
let boundHost: AppHost | null = null;
let priorHost: AppHost | null = null;
const originalVibrate = Object.getOwnPropertyDescriptor(happy.navigator, "vibrate");

/**
 * A bounded recording host for this leaf-only presenter fixture: the herd route
 * (and its leaf controls) re-render from their own domain subscriptions. The
 * zero-global-commit windows below observe the REAL installed host registry —
 * typed grouping writes publish only the preferences domain, so commit and
 * requestCommit stay 0 — while the later intentional board navigation is
 * deliberately outside the window. The host is a bounded observer (no App
 * render) and is restored to the previous registry identity in finally.
 */
function installRecordingHost(): void {
  // Save the pre-install real host: releaseAppHost only clears when it matches,
  // so restore must hand the exact prior host (or null) back in finally.
  priorHost = appHost();
  hostCommitted = 0;
  hostRequested = 0;
  boundHost = {
    commit: () => { hostCommitted += 1; },
    requestCommit: () => { hostRequested += 1; },
    unmount: () => {},
  };
  registerAppHost(boundHost);
}
function restoreHost(): void {
  if (!boundHost) return;
  // Release-identity guard: only restore our saved prior if we STILL hold the
  // registration (another host may have replaced the observer within the
  // window — do not overwrite it with our saved prior). Local cleanup is
  // idempotent and always runs in finally.
  const current = appHost();
  if (current === boundHost) {
    if (priorHost) registerAppHost(priorHost);
    else releaseAppHost(boundHost);
  }
  boundHost = null;
  priorHost = null;
}

type SeedStatus = "idle" | "working" | "done" | "blocked" | "unknown";

function seedAgent(id: string, workspace: string, status: SeedStatus = "idle") {
  return { id, workspace, status };
}

/** Drive the herd through the dashboard owner action, not the legacy facade. */
function seed(items: ReturnType<typeof seedAgent>[]): void {
  const workspaces = [...new Set(items.map((item) => item.workspace))]
    .map((workspace) => ({ workspace_id: workspace, label: workspace }));
  const tabs = [...new Set(items.map((item) => item.workspace))]
    .map((workspace) => ({ tab_id: `${workspace}:tab`, workspace_id: workspace, label: "main" }));
  const panes = items.map((item) => ({
    pane_id: item.id,
    workspace_id: item.workspace,
    tab_id: `${item.workspace}:tab`,
    cwd: `/tmp/${item.workspace}`,
    agent: "codex",
    agent_status: item.status,
    label: item.id,
  }));
  replaceAgentsFromSnapshot({ workspaces, tabs, panes });
}

function visible(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

function liveHandle(connected: boolean): void {
  attachLiveSession({ isConnected: () => connected } as never);
}

function liveNull(): void {
  attachLiveSession(null);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  visible("visible");
  vibrations.length = 0;
  Object.defineProperty(happy.navigator, "vibrate", {
    configurable: true,
    value: (ms: number) => {
      vibrations.push(ms);
      return true;
    },
  });
  // Scoped named setup: resetBoardTestDOM does not reset the domains.
  setPhase("live");
  setScreen("home");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  setOperationBusy(false);
  setNetworkOnline(true);
  setComputers([]);
  applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
  setCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, []);
  liveHandle(true);
  selectPane("");
  resetHerdAttention();
  resetHerdAttentionSnapshot();
  // A transition left queued by another test would mark a card as morphing.
  nextTransition("fade");
  takeTransition();
});

afterEach(() => {
  restoreHost();
  unmountReact();
  resetHerdAttention();
  resetHerdAttentionSnapshot();
  takeTransition();
  attachLiveSession(null);
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  setScreen("home");
  visible("hidden");
  if (originalVibrate) Object.defineProperty(happy.navigator, "vibrate", originalVibrate);
  else delete (happy.navigator as unknown as { vibrate?: unknown }).vibrate;
});

describe("herd presenter", () => {
  test("a completion batch vibrates once, and only while the document is visible", () => {
    seed([seedAgent("p1", "alpha", "working"), seedAgent("p2", "beta", "working")]);
    presentHerdView();
    expect(vibrations).toEqual([]);
    seed([seedAgent("p1", "alpha", "done"), seedAgent("p2", "beta", "done")]);
    presentHerdView();
    expect(vibrations).toEqual([14]);
    // The batch was consumed: repeating the projection acknowledges nothing again.
    presentHerdView();
    expect(vibrations).toEqual([14]);
  });

  test("the whole entrance is for a list that was built: its first rows, another grouping, another list", () => {
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "alpha")]);
    const first = presentHerdView();
    expect([first.stagger, first.epoch]).toEqual([true, 1]);
    // The same rows again, and a session more or less: that list still, and nothing replays.
    expect(presentHerdView().stagger).toBe(false);
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "alpha"), seedAgent("p3", "beta")]);
    const joined = presentHerdView();
    expect([joined.stagger, joined.epoch]).toEqual([false, 1]);
    seed([seedAgent("p1", "alpha"), seedAgent("p3", "beta")]);
    const left = presentHerdView();
    expect([left.stagger, left.epoch]).toEqual([false, 1]);

    setListGroup("space");
    const regrouped = presentHerdView();
    expect([regrouped.stagger, regrouped.epoch]).toEqual([true, 2]);
    expect(presentHerdView().stagger).toBe(false);

    // No row in common with what was shown: another computer's list, or another Herdr session's.
    seed([seedAgent("q1", "gamma"), seedAgent("q2", "gamma")]);
    const other = presentHerdView();
    expect([other.stagger, other.epoch]).toEqual([true, 3]);
  });

  test("a reconnect brings the same rows back to the same list, so nothing replays", () => {
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "beta")]);
    presentHerdView();
    // A disconnect retires the rows; the empty list is not a list of its own.
    resetDashboard();
    const empty = presentHerdView();
    expect([empty.stagger, empty.epoch]).toEqual([false, 1]);
    // The reconnect reports the very sessions the reader was looking at.
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "beta")]);
    const back = presentHerdView();
    expect([back.stagger, back.epoch]).toEqual([false, 1]);
  });

  test("another computer or another Herdr session is another list, even when its rows repeat", () => {
    setCredential({ daemonId: "daemon-a" } as never);
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "alpha")]);
    expect(presentHerdView().stagger).toBe(true);
    expect(presentHerdView().stagger).toBe(false);
    // Pane ids repeat across computers: only the scope can tell them apart.
    resetDashboard();
    setCredential({ daemonId: "daemon-b" } as never);
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "alpha")]);
    expect(presentHerdView().stagger).toBe(true);
    // ...and across Herdr sessions on the same computer, with or without a gap.
    attachLiveSession({ isConnected: () => true, herdSession: () => "release" } as never);
    expect(presentHerdView().stagger).toBe(true);
    resetDashboard();
    attachLiveSession({ isConnected: () => true, herdSession: () => "scratch" } as never);
    seed([seedAgent("p1", "alpha")]);
    expect(presentHerdView().stagger).toBe(true);
    setCredential(null);
  });

  test("a subscriber is told when the list is built again, though nothing else of the attention changed", () => {
    seed([seedAgent("p1", "alpha")]);
    presentHerdView();
    let notified = 0;
    const stop = subscribeHerdAttention(() => { notified += 1; });
    setListGroup("space");
    presentHerdView();
    setListGroup("agent");
    presentHerdView();
    stop();
    expect(notified).toBe(2);
    expect(readHerdInput(readHerdAttention()).listEpoch).toBe(3);
  });

  test("a completion in the background acknowledges nothing", () => {
    visible("hidden");
    seed([seedAgent("p1", "alpha", "working")]);
    presentHerdView();
    seed([seedAgent("p1", "alpha", "done")]);
    const view = presentHerdView();
    expect(vibrations).toEqual([]);
    expect(view.groups[0].cards[0].className).toContain("ac-done");
  });

  test("grouped modes reconcile the accordion defaults, flat leaves them alone", () => {
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "beta"), seedAgent("p3", "gamma")]);
    setListGroup("flat");
    setListGroupCollapsed({ kept: true });
    presentHerdView();
    expect(listGroupCollapsedNow()).toEqual({ kept: true });

    setListGroup("space");
    const view = presentHerdView();
    expect(listGroupCollapsedNow()).toEqual({ alpha: false, beta: true, gamma: true });
    expect(view.groups.map((group) => group.collapsed)).toEqual([false, true, true]);
    // Reconciling again is idempotent: the reader's own choice survives.
    presentHerdView();
    expect(listGroupCollapsedNow()).toEqual({ alpha: false, beta: true, gamma: true });
  });

  test("the toggle folds the groups the reader was shown and needs no repaint", () => {
    seed([seedAgent("p1", "alpha"), seedAgent("p2", "beta")]);
    setListGroup("space");
    const view = presentHerdView();
    expect(listGroupCollapsedNow().beta).toBe(true);
    installRecordingHost();
    try {
      toggleHerdGroup("beta", view.groupIds);
      expect(listGroupCollapsedNow().beta).toBe(false);
      expect(listGroupCollapsedNow().alpha).toBe(false);
      // The typed action publishes; the subscribed route repaints itself, and
      // the real installed host records zero commits/requests for the fold.
      expect(hostCommitted).toBe(0);
      expect(hostRequested).toBe(0);
      // A group that is not on screen cannot be toggled into existence.
      toggleHerdGroup("gamma", view.groupIds);
      expect(listGroupCollapsedNow().gamma).toBeUndefined();
      expect(hostCommitted).toBe(0);
      expect(hostRequested).toBe(0);
    } finally {
      restoreHost();
    }
  });

  test("a later presentation of another list cannot steal a mounted list's fold", async () => {
    seed([seedAgent("p1", "alpha")]);
    setListGroup("space");
    const mounted = presentHerdView();
    expect(mounted.groupIds).toEqual(["alpha"]);
    // The mounted herd screen is the presented model, not the live HomePage route:
    // a later presentation publishes the dashboard, and the actual route would
    // follow it. The component fixture deliberately holds the fixed props.
    act(() =>
      renderReact(
        createElement(HerdScreen, {
          view: mounted,
          actions: createHerdActions(herdActionPorts()),
          variant: "page",
        }),
      ),
    );
    const app = appRoot();
    const heading = app.querySelector<HTMLButtonElement>(".group-title")!;

    // Another surface presents a different herd while the first stays mounted.
    seed([seedAgent("p9", "beta")]);
    let other!: ReturnType<typeof presentHerdView>;
    act(() => {
      other = presentHerdView();
    });
    expect(other.groupIds).toEqual(["beta"]);

    act(() => heading.click());
    expect(listGroupCollapsedNow()).toEqual({ alpha: true });
    expect(listGroupCollapsedNow().beta).toBeUndefined();
    act(() => unmountReact());
  });

  test("the projection carries the record's gates into the model", () => {
    seed([seedAgent("p1", "alpha", "done")]);
    selectPane("p1");
    nextTransition("expand", "p1");
    const view = presentHerdView();
    expect(view.groups[0].cards[0].selected).toBe(true);
    expect(view.groups[0].cards[0].sharesTransition).toBe(true);
    expect(view.attention.map((item) => `${item.kind}:${item.paneId}`)).toEqual(["done:p1"]);
    expect(view.create).toEqual({ label: t("home.new"), aria: t("home.newAria"), disabled: false });
    // Another pane morphing leaves this card's title alone.
    nextTransition("expand", "other");
    expect(presentHerdView().groups[0].cards[0].sharesTransition).toBe(false);
    takeTransition();
  });

  test("an idle-to-working mark publishes a new detached snapshot", () => {
    seed([seedAgent("p1", "alpha")]);
    presentHerdView();
    presentHerdView();
    const retained = readHerdAttention();
    const previousMark = retained.markOf("p1");
    let notifications = 0;
    const stop = subscribeHerdAttention(() => {
      notifications += 1;
    });
    seed([seedAgent("p1", "alpha", "working")]);
    presentHerdView();
    expect(previousMark).toBe("");
    expect(retained.markOf("p1")).toBe("");
    expect(readHerdAttention().markOf("p1")).toBe("changed");
    expect(retained === readHerdAttention()).toBe(false);
    expect(notifications).toBe(1);
    stop();
  });

  test("a retained attention snapshot does not follow a later presentation", () => {
    seed([seedAgent("p1", "alpha")]);
    presentHerdView();
    presentHerdView();
    const previous = readHerdAttention();
    const mark = previous.markOf("p1");
    seed([seedAgent("p1", "alpha", "working")]);
    presentHerdView();
    expect(previous.markOf("p1")).toBe(mark);
  });

  test("attention plain metadata cannot be rewritten through its published object", () => {
    seed([seedAgent("p1", "alpha")]);
    presentHerdView();
    presentHerdView();
    const previous = readHerdAttention();
    let notifications = 0;
    const stop = subscribeHerdAttention(() => {
      notifications += 1;
    });
    try {
      previous.stagger = true;
      previous.completed.push("EXTERNAL");
    } catch {
      /* frozen snapshot */
    }
    expect({
      stagger: readHerdAttention().stagger,
      completed: [...readHerdAttention().completed],
      notifications,
    }).toEqual({ stagger: false, completed: [], notifications: 0 });
    stop();
  });

  test("the input snapshot reports liveness, connection and capability as the domains have them", () => {
    const attention = { stagger: false, markOf: () => "" as const, isDismissing: () => false, completed: [] };
    expect(readHerdInput(attention)).toMatchObject({
      liveness: "live", connected: true, networkOnline: true, runtimeKind: "herdr",
      createConversation: true, operationBusy: false, morphingPaneId: null,
    });
    liveHandle(false);
    setNetworkOnline(false);
    setOperationBusy(true);
    setCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    nextTransition("pop", "p9");
    const offline = readHerdInput(attention);
    expect(offline.liveness).toBe("unverifiable");
    expect(offline.connected).toBe(false);
    expect(offline.networkOnline).toBe(false);
    expect(offline.operationBusy).toBe(true);
    expect(offline.createConversation).toBe(false);
    expect(offline.morphingPaneId).toBe(morphingPane());
    expect(offline.status.tone).toBe("warn");
  });
});

function listGroupCollapsedNow(): Record<string, boolean> {
  return { ...preferencesStore.get().listGroupCollapsed };
}

describe("what the list hears from preferences", () => {
  const key = () => herdPreferencesKey(preferencesStore.get());

  test("a terminal's font or wrap publishes without moving the list's key", () => {
    seed([seedAgent("p1", "alpha")]);
    const before = key();
    const published = preferencesStore.get();
    setTermFontPx(termFontPx() + 2);
    setTermWrap(!termWrap());
    expect(preferencesStore.get()).not.toBe(published);
    expect(key()).toBe(before);
  });

  test("the grouping, a fold, a stamp and a pin each move it", () => {
    seed([seedAgent("p1", "alpha")]);
    const before = key();
    setListGroup("space");
    const regrouped = key();
    expect(regrouped).not.toBe(before);
    setListGroupCollapsed({ alpha: true });
    const folded = key();
    expect(folded).not.toBe(regrouped);
    setListGroupCollapsed({ alpha: false });
    expect(key()).not.toBe(folded);

    // The reader opening a pane reorders the list; a pin moves its row.
    const unfolded = key();
    rememberPane("p1");
    const activated = key();
    expect(activated).not.toBe(unfolded);
    togglePanePin("p1");
    expect(key()).not.toBe(activated);
  });
});

describe("herd action ports", () => {
  test("the menu guard is read when the press lands, not when the card rendered", () => {
    const ports = herdActionPorts();
    expect(ports.canOpenMenu()).toBe(true);
    setOperationBusy(true);
    expect(ports.canOpenMenu()).toBe(false);
    setOperationBusy(false);
    liveHandle(false);
    expect(ports.canOpenMenu()).toBe(false);
    liveNull();
    expect(ports.canOpenMenu()).toBe(false);
  });

  test("the group port is the bridge toggle, and the board port navigates", () => {
    const ports = herdActionPorts();
    seed([seedAgent("p1", "alpha")]);
    setListGroup("space");
    const view = presentHerdView();
    installRecordingHost();
    try {
      ports.toggleGroup("alpha", view.groupIds);
      expect(listGroupCollapsedNow().alpha).toBe(true);
      expect(hostCommitted).toBe(0);
      expect(hostRequested).toBe(0);
    } finally {
      restoreHost();
    }
    // The port is fire-and-forget; the later board navigation is an intentional
    // navigation outside the zero window, and the board is already up.
    ports.openBoard();
    expect(currentScreen()).toBe("board");
    expect(boardReturn()).toBe(false);
  });
});
