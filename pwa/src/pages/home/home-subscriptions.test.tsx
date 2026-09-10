import { resetBoardTestDOM, happy } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { appHost } from "../../app/host";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { setScreen } from "../../app/navigation-store";
import {
  listGroup,
  resetHerdPresentationChoices,
  setListGroup,
  togglePanePin,
} from "../../features/settings/preferences-store";
import { resetHerdAttention } from "../../lib/herd-attention";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/session-types";
import { presentHerdView, resetHerdAttentionSnapshot, toggleHerdGroup } from "./herd-bridge";
import { selectPane } from "../../features/session/session-store";

const vibrations: number[] = [];
const originalVibrate = Object.getOwnPropertyDescriptor(happy.navigator, "vibrate");

function visible(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

type SeedStatus = "idle" | "working" | "done" | "blocked" | "unknown";

/** Drive the herd through the dashboard owner action, not the legacy facade. */
function boot(statuses: Array<[string, string, SeedStatus]>): void {
  attachLiveSession({ isConnected: () => true, paneRead: async () => ({ text: "", hash: "" }) } as unknown as LiveSession);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, []);
  const workspaces = [...new Set(statuses.map(([, workspace]) => workspace))];
  replaceAgentsFromSnapshot({
    workspaces: workspaces.map((workspace) => ({ workspace_id: workspace, label: workspace, cwd: `/tmp/${workspace}` })),
    tabs: workspaces.map((workspace) => ({ tab_id: `${workspace}:t`, workspace_id: workspace, label: "main" })),
    panes: statuses.map(([paneId, workspace, status]) => ({
      pane_id: paneId,
      workspace_id: workspace,
      tab_id: `${workspace}:t`,
      cwd: `/tmp/${workspace}`,
      agent: "codex",
      agent_status: status,
      label: paneId,
    })),
  });
  setListGroup("space");
}

/** Replace the herd via the owner action with explicit pane/workspace rows. */
function seed(rows: Array<{ pane: string; workspace: string; status: SeedStatus }>): void {
  replaceAgentsFromSnapshot({
    workspaces: [...new Set(rows.map((row) => row.workspace))].map((workspace) => ({ workspace_id: workspace, label: workspace[0].toUpperCase() + workspace.slice(1) })),
    tabs: [...new Set(rows.map((row) => row.workspace))].map((workspace) => ({ tab_id: `${workspace}:t`, workspace_id: workspace, label: "main" })),
    panes: rows.map((row) => ({
      pane_id: row.pane,
      workspace_id: row.workspace,
      tab_id: `${row.workspace}:t`,
      cwd: `/tmp/${row.workspace}`,
      agent: "codex",
      agent_status: row.status,
      label: row.pane,
    })),
  });
}

function headings(): string[] {
  return [...appRoot().querySelectorAll<HTMLButtonElement>(".group-title")].map((node) => node.getAttribute("aria-expanded")!);
}

/**
 * observe ALL real publication boundaries — the real synchronous host.commit AND
 * host.requestCommit (which queues app/commit's commitApp directly, bypassing
 * host.commit) — forwarding each to the production implementation so the App
 * still renders. A subscription-only data update must arrive through neither;
 * counting just host.commit misses the queued requestCommit path. A real
 * composition change (selecting a pane) is allowed to go through the App's OWN
 * scheduled requestCommit. Restored in finally so a failed assertion never
 * leaves a mounted seam wrapped. The legacy render-port counter is retired with
 * the renderer; the real host port counters are the authority.
 */
function observeCommits(): {
  hostCommits: () => number;
  requestCommits: () => number;
  restore: () => void;
} {
  let hostCommits = 0;
  let requestCommits = 0;
  const host = appHost();
  if (!host) throw new Error("actual App host missing");
  const originalCommit = host.commit;
  const originalRequest = host.requestCommit;
  host.commit = function (...args: Parameters<typeof originalCommit>) {
    hostCommits += 1;
    return originalCommit.apply(this, args);
  };
  host.requestCommit = function () {
    requestCommits += 1;
    return originalRequest.call(this);
  };
  return {
    hostCommits: () => hostCommits,
    requestCommits: () => requestCommits,
    restore: () => {
      host.commit = originalCommit;
      host.requestCommit = originalRequest;
    },
  };
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
  setPhase("live");
  setScreen("home");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  setOperationBusy(false);
  setNetworkOnline(true);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  resetHerdAttention();
  resetHerdAttentionSnapshot();
  attachLiveSession(null);
  mountTestApp();
});

afterEach(() => {
  act(() => unmountTestApp());
  resetHerdAttention();
  resetHerdAttentionSnapshot();
  attachLiveSession(null);
  selectPane("");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  visible("hidden");
  if (originalVibrate) Object.defineProperty(happy.navigator, "vibrate", originalVibrate);
  else delete (happy.navigator as unknown as { vibrate?: unknown }).vibrate;
});

describe("mounted home updates from typed domain actions", () => {
  test("a fold publishes and the list updates with no repaint or host commit at all", () => {
    act(() => boot([["p1", "alpha", "working"], ["p2", "beta", "working"], ["p3", "gamma", "working"]]));
    commitTest();
    // The commit boundary's per-commit preparation consumes attention and reconciles.
    let groupIds: string[] = [];
    act(() => {
      groupIds = presentHerdView().groupIds;
    });
    expect(headings()).toEqual(["true", "false", "false"]);
    expect(listGroup()).toBe("space");

    const counts = observeCommits();
    try {
      act(() => toggleHerdGroup("beta", groupIds));
      expect(headings()).toEqual(["true", "true", "false"]);
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);

      act(() => toggleHerdGroup("beta", groupIds));
      expect(headings()).toEqual(["true", "false", "false"]);
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
    } finally {
      counts.restore();
    }
  });

  test("a pin reorders the mounted list into its pinned section without a repaint", () => {
    act(() => boot([["p1", "alpha", "working"], ["p2", "beta", "working"]]));
    commitTest();
    act(() => presentHerdView());
    expect(appRoot().querySelector(".section-title")).toBeNull();
    const counts = observeCommits();
    try {
      act(() => togglePanePin("p2"));
      const titles = [...appRoot().querySelectorAll(".group-name")].map((node) => node.textContent);
      expect(titles[0]).toBe(t("group.pinned"));
      expect(appRoot().querySelector("article.card.pinned .card-name")?.textContent).toBe("p2");
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
    } finally {
      counts.restore();
    }
  });

  test("a snapshot selection updates the card through the App's own commit, never the render port", async () => {
    act(() => boot([["p1", "alpha", "working"]]));
    commitTest();
    act(() => presentHerdView());
    expect(appRoot().querySelector(".card-name")?.textContent).toBe("p1");
    const counts = observeCommits();
    try {
      // selectPane stages a composition write: the mounted App publishes and renders
      // it through its own scheduled commit. No legacy render() may fire, and the
      // mounted host stays the same stable App.
      const host = appHost();
      await act(async () => {
        selectPane("p1");
        // Flush the App's own scheduled composition commit inside this act.
        for (let tick = 0; tick < 4; tick += 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });
      expect(appRoot().querySelector(".card.sel")).not.toBeNull();
      // No legacy render: the composition commit is the App's OWN scheduled
      // requestCommit (drained above), which stays with the same stable host.
      expect(counts.requestCommits()).toBeGreaterThanOrEqual(1);
      expect(appHost()).toBe(host);
    } finally {
      counts.restore();
    }
  });

  test("attention and its haptic belong to the presentation, never to a React render", async () => {
    act(() => boot([["p1", "alpha", "working"], ["p2", "beta", "working"]]));
    commitTest();
    act(() => presentHerdView());
    expect(vibrations).toEqual([]);
    expect(appRoot().querySelectorAll(".card.ac-done")).toHaveLength(0);

    const counts = observeCommits();
    try {
      // The daemon reports both turns finished; the domain publishes and the mounted
      // list re-renders by itself — but nothing has acknowledged the batch yet.
      act(() => {
        seed([
          { pane: "p1", workspace: "alpha", status: "done" },
          { pane: "p2", workspace: "beta", status: "done" },
        ]);
      });
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
      expect(vibrations).toEqual([]);

      // The paint boundary consumes the batch: one haptic, and the sweep is visible.
      act(() => presentHerdView());
      expect(vibrations).toEqual([14]);
      expect(appRoot().querySelectorAll(".card.ac-done")).toHaveLength(2);

      // Another subscription-driven selection acknowledges nothing a second
      // time. selectPane is a composition, so drain the App's OWN scheduled commit
      // inside this act; it never calls the legacy render port.
      await act(async () => {
        selectPane("p1");
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });
      expect(vibrations).toEqual([14]);
      expect(appRoot().querySelectorAll(".card.ac-done")).toHaveLength(2);
      act(() => presentHerdView());
      expect(vibrations).toEqual([14]);
      // No legacy render anywhere; the attention sweep itself never asks for one.
    } finally {
      counts.restore();
    }
  });

  test("choosing workspace grouping prepares the default accordion with no repaint", () => {
    act(() => {
      attachLiveSession({ isConnected: () => true, paneRead: async () => ({ text: "", hash: "" }) } as unknown as LiveSession);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, []);
      replaceAgentsFromSnapshot({
        workspaces: [
          { workspace_id: "w1", label: "Alpha" },
          { workspace_id: "w2", label: "Beta" },
          { workspace_id: "w3", label: "Gamma" },
        ],
        tabs: [
          { tab_id: "t1", workspace_id: "w1", label: "main" },
          { tab_id: "t2", workspace_id: "w2", label: "main" },
          { tab_id: "t3", workspace_id: "w3", label: "main" },
        ],
        panes: [
          { pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "codex", agent_status: "idle", label: "one" },
          { pane_id: "p2", workspace_id: "w2", tab_id: "t2", agent: "codex", agent_status: "idle", label: "two" },
          { pane_id: "p3", workspace_id: "w3", tab_id: "t3", agent: "codex", agent_status: "idle", label: "three" },
        ],
      });
      setListGroup("flat");
    });
    commitTest();
    const counts = observeCommits();
    try {
      const group = [...appRoot().querySelectorAll<HTMLButtonElement>("[role=radio]")].find(
        (node) => node.textContent === t("list.space"),
      )!;
      act(() => group.click());
      expect([...appRoot().querySelectorAll(".group-title")].map((node) => node.getAttribute("aria-expanded"))).toEqual([
        "true",
        "false",
        "false",
      ]);
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
    } finally {
      counts.restore();
    }
  });

  test("an idle-to-working mark reaches the mounted list through the attention snapshot", () => {
    act(() => {
      attachLiveSession({ isConnected: () => true, paneRead: async () => ({ text: "", hash: "" }) } as unknown as LiveSession);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, []);
      replaceAgentsFromSnapshot({
        workspaces: [{ workspace_id: "w1", label: "Alpha" }],
        tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "codex", agent_status: "idle", label: "one" }],
      });
      setListGroup("flat");
    });
    // Two presentations establish the unseen baseline (no mark yet).
    act(() => {
      presentHerdView();
      presentHerdView();
    });
    commitTest();
    expect(appRoot().querySelectorAll(".ac-changed").length).toBe(0);
    const counts = observeCommits();
    try {
      // Boundary 1: the source update publishes and the mounted list re-renders by
      // subscription alone — no render() and no host.commit — but attention is not
      // consumed on a data publication, so no mark is visible yet.
      act(() => {
        replaceAgentsFromSnapshot({
          workspaces: [{ workspace_id: "w1", label: "Alpha" }],
          tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
          panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "codex", agent_status: "working", label: "one" }],
        });
      });
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
      expect(appRoot().querySelectorAll(".ac-changed").length).toBe(0);
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
      // Boundary 2: the presentation consumes attention; that is where the mark appears.
      act(() => presentHerdView());
      expect(appRoot().querySelectorAll(".ac-changed").length).toBe(1);
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
    } finally {
      counts.restore();
    }
  });

  test("a background presentation acknowledges the batch without vibrating", () => {
    visible("hidden");
    act(() => boot([["p1", "alpha", "working"]]));
    commitTest();
    act(() => presentHerdView());
    const counts = observeCommits();
    try {
      // Boundary 1: the daemon reports done; the domain publishes, but the
      // background presentation has not consumed the batch yet.
      act(() => {
        seed([{ pane: "p1", workspace: "alpha", status: "done" }]);
      });
      expect(vibrations).toEqual([]);
      expect(appRoot().querySelectorAll(".card.ac-done")).toHaveLength(0);
      // Boundary 2: the presentation consumes the batch; hidden, so it marks the
      // card without vibrating and never asks for a render or a whole-App commit.
      act(() => presentHerdView());
      expect(vibrations).toEqual([]);
      expect(appRoot().querySelectorAll(".card.ac-done")).toHaveLength(1);
      expect(counts.hostCommits()).toBe(0);
      expect(counts.requestCommits()).toBe(0);
    } finally {
      counts.restore();
    }
  });
});
