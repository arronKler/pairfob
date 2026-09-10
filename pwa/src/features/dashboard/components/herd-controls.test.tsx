import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { replaceAgentsFromSnapshot, resetDashboard } from "../catalog-store";
import { listGroup, preferencesStore, setListGroup, setListGroupCollapsed } from "../../settings/preferences-store";
import { setLang, t } from "../../../lib/i18n";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { appHost, registerAppHost, releaseAppHost, type AppHost } from "../../../app/host";
import { CompletionCount, ListGroupControl } from "./herd-controls";

const app = appRoot;

let hostCommitted = 0;
let hostRequested = 0;
let boundHost: AppHost | null = null;
let priorHost: AppHost | null = null;

/**
 * A bounded recording host for this leaf-only fixture: the control is its own
 * preferences-store subscriber, so a host that never paints still updates. The
 * zero-commit window observes the REAL installed host registry — commit and
 * requestCommit stay 0 while the typed grouping actions only publish the
 * preferences domain. The host is a bounded observer (no App render), restored
 * to the previous registry identity in finally.
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
function withinZeroCommitWindow(action: () => void): void {
  installRecordingHost();
  try {
    action();
    expect(hostCommitted).toBe(0);
    expect(hostRequested).toBe(0);
  } finally {
    restoreHost();
  }
}

function mount(node: ReactNode): void {
  act(() => renderReact(node));
}

function segment(label: string): HTMLButtonElement {
  const found = [...app().querySelectorAll<HTMLButtonElement>(".seg-item")].find((node) => node.textContent === label);
  if (!found) throw new Error(`missing segment ${label}`);
  return found;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetDashboard();
  setListGroup("flat");
  setListGroupCollapsed({});
});

afterEach(() => {
  restoreHost();
  act(() => unmountReact());
  resetDashboard();
  setListGroup("flat");
  setListGroupCollapsed({});
});

describe("list grouping control", () => {
  test("it reads the preference it owns and marks exactly one choice", () => {
    mount(createElement(ListGroupControl));
    const items = [...app().querySelectorAll<HTMLButtonElement>(".seg-item")];
    expect(items.map((node) => node.textContent)).toEqual([t("list.flat"), t("list.space"), t("list.agent")]);
    expect(items.map((node) => node.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(app().querySelector(".seg")?.getAttribute("role")).toBe("radiogroup");
    expect(app().querySelector(".seg")?.getAttribute("aria-label")).toBe(t("list.groupAria"));
  });

  test("a new grouping publishes, resets the accordion and repaints nothing", () => {
    resetDashboard();
    setListGroupCollapsed({ alpha: false, beta: true });
    mount(createElement(ListGroupControl));
    withinZeroCommitWindow(() => {
      act(() => segment(t("list.space")).click());
    });
    expect(listGroup()).toBe("space");
    expect(listGroup()).toBe("space");
    expect(preferencesStore.get().listGroupCollapsed).toEqual({});
    // The control is its own subscriber: a host that never paints still updates.
    expect(segment(t("list.space")).getAttribute("aria-checked")).toBe("true");
    expect(segment(t("list.flat")).getAttribute("aria-checked")).toBe("false");
  });

  test("a grouping choice with a live herd writes the default accordion, not an empty map", () => {
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
    mount(createElement(ListGroupControl));
    withinZeroCommitWindow(() => {
      act(() => segment(t("list.space")).click());
    });
    expect(listGroup()).toBe("space");
    expect(preferencesStore.get().listGroupCollapsed).toEqual({ w1: false, w2: true, w3: true });
  });

  test("choosing the current grouping publishes nothing", () => {
    mount(createElement(ListGroupControl));
    const before = preferencesStore.get();
    withinZeroCommitWindow(() => {
      act(() => segment(t("list.flat")).click());
    });
    expect(preferencesStore.get()).toBe(before);
  });

  test("the grouping survives a remount through the preference it persists", () => {
    mount(createElement(ListGroupControl));
    act(() => segment(t("list.agent")).click());
    act(() => unmountReact());
    mount(createElement(ListGroupControl));
    expect(segment(t("list.agent")).getAttribute("aria-checked")).toBe("true");
  });
});

describe("completion count", () => {
  test("no unread completion means no control at all", () => {
    mount(createElement(CompletionCount, { count: 0 }));
    expect(app().querySelector(".done-count")).toBeNull();
  });

  test("it counts the cards still waiting and scrolls to the first one", () => {
    const card = document.createElement("article");
    card.className = "card status-done";
    let scrolled: unknown = null;
    card.scrollIntoView = (options) => {
      scrolled = options;
    };
    document.body.append(card);
    mount(createElement(CompletionCount, { count: 2 }));
    const count = app().querySelector<HTMLButtonElement>(".done-count")!;
    expect(count.textContent).toBe(t("home.doneCount", { count: "2" }));
    expect(count.getAttribute("aria-label")).toBe(t("home.doneCountAria", { count: "2" }));
    act(() => count.click());
    expect(scrolled).toEqual({ behavior: "smooth", block: "center" });
    card.remove();
  });
});