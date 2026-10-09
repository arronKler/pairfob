import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { replaceAgentsFromSnapshot, resetDashboard } from "../catalog-store";
import { listGroup, preferencesStore, resetHerdPresentationChoices, setListGroup, setListGroupCollapsed } from "../../settings/preferences-store";
import { setLang, t } from "../../../lib/i18n";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { appHost, registerAppHost, releaseAppHost, type AppHost } from "../../../app/host";
import { chooseListGroup, GroupModeButton } from "./herd-controls";

const app = appRoot;
const presentationRestorer = new WorkspaceSnapshotRestorer();

let hostCommitted = 0;
let hostRequested = 0;
let boundHost: AppHost | null = null;
let priorHost: AppHost | null = null;

/**
 * A bounded recording host for this leaf-only fixture: the grouping choice is a
 * typed preferences action, so its subscribers update without a host that
 * paints. The zero-commit window observes the REAL installed host registry —
 * commit and requestCommit stay 0 while the typed grouping actions only publish
 * the preferences domain. The host is a bounded observer (no App render),
 * restored to the previous registry identity in finally.
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

beforeEach(async () => {
  await resetBoardTestDOM();
  presentationRestorer.capture();
  resetHerdPresentationChoices();
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
  presentationRestorer.restore();
});

describe("list grouping choice", () => {
  test("a new grouping publishes, resets the accordion and repaints nothing", () => {
    resetDashboard();
    setListGroupCollapsed({ alpha: false, beta: true });
    withinZeroCommitWindow(() => {
      act(() => chooseListGroup("space"));
    });
    expect(listGroup()).toBe("space");
    expect(preferencesStore.get().listGroupCollapsed).toEqual({});
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
    withinZeroCommitWindow(() => {
      act(() => chooseListGroup("space"));
    });
    expect(listGroup()).toBe("space");
    expect(preferencesStore.get().listGroupCollapsed).toEqual({ w1: false, w2: true, w3: true });
  });

  test("choosing the current grouping publishes nothing", () => {
    const before = preferencesStore.get();
    withinZeroCommitWindow(() => {
      act(() => chooseListGroup("flat"));
    });
    expect(preferencesStore.get()).toBe(before);
  });
});

describe("grouping button", () => {
  test("it names the current grouping and opens the sheet", () => {
    let opened = 0;
    mount(createElement(GroupModeButton, { mode: "space", onOpen: () => { opened += 1; } }));
    const button = app().querySelector<HTMLButtonElement>(".herd-mode")!;
    expect(button.textContent).toBe(t("list.modeSpace"));
    expect(button.getAttribute("aria-label")).toBe(t("list.modeAria", { mode: t("list.modeSpace") }));
    expect(button.hasAttribute("title")).toBe(false);
    act(() => button.click());
    expect(opened).toBe(1);
  });

  test("with room for the icon only, the name moves to the label and the tooltip", () => {
    mount(createElement(GroupModeButton, { mode: "agent", onOpen: () => {}, iconOnly: true }));
    const button = app().querySelector<HTMLButtonElement>(".herd-mode")!;
    const name = t("list.modeAria", { mode: t("list.modeAgent") });
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-label")).toBe(name);
    expect(button.getAttribute("title")).toBe(name);
  });
});
