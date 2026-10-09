import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { attachLiveSession } from "../../features/computers/catalog-store";
import type { PaletteSession } from "../../features/command-palette";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/client";
import { batch } from "../../shared/model/domain-store";
import { publishAllDomains } from "../domain-publication";
import { setScreen } from "../navigation-store";
import { herdEmptyView } from "../../features/dashboard/model/herd-view";
import { DeskEmpty, DeskEmptyView, deskEmptyState } from "./desk-empty";

let root: Root | null = null;
let container: HTMLElement;

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const entries = () => [...container.querySelectorAll<HTMLButtonElement>(".desk-ticket")];
const actions = () => [...container.querySelectorAll<HTMLButtonElement>(".desk-empty-actions button")];

function session(paneId: string, title: string, status: "blocked" | "done" = "blocked"): PaletteSession {
  return {
    type: "session", key: `session:${paneId}`, paneId, kind: "agent", agentKind: "claude", title,
    statusLabel: t(`status.${status}`), statusTone: status, meta: "claude · pairfob · implementation", waiting: status === "blocked",
  };
}

function seed(statuses: Record<string, string>): void {
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/work/pairfob" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "implementation" }],
    panes: Object.entries(statuses).map(([id, status]) => ({
      pane_id: id, workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob", agent: "codex", agent_status: status, label: id,
    })),
  } as never);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  batch(() => {
    setPhase("live");
    setScreen("home");
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    attachLiveSession({ isConnected: () => true } as LiveSession);
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, []);
    resetDashboard();
    seed({ ask: "blocked", fin: "done", run: "working" });
  });
  publishAllDomains();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  act(() => root?.unmount());
  root = null;
  container.remove();
  batch(() => {
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  });
  publishAllDomains();
});

describe("desk empty view", () => {
  test("sessions that wait are entries that hand their pane and title to the open action", () => {
    const opened: Array<[string, string | null]> = [];
    act(() => root!.render(<DeskEmptyView attention={[session("p1", "Review swipes"), session("p2", "Paginate audit log")]} hasSessions state={null}
      create={{ disabled: false }} shortcut={false}
      onOpen={(paneId, source) => opened.push([paneId, source?.textContent ?? null])} onCreate={() => undefined} onSearch={() => undefined} onAction={() => undefined} />));
    expect(container.querySelector(".main-empty .desk-empty-title")?.textContent).toBe(t("deskEmpty.waiting", { count: "2" }));
    expect(container.querySelector(".desk-ticket-list")?.getAttribute("aria-label")).toBe(t("list.needsYouAria"));
    expect(entries().map((entry) => [entry.dataset.paneId, entry.className, entry.querySelector(".desk-ticket-meta")?.textContent])).toEqual([
      ["p1", "desk-ticket is-blocked", `${t("status.blocked")} · claude · pairfob · implementation`],
      ["p2", "desk-ticket is-blocked", `${t("status.blocked")} · claude · pairfob · implementation`],
    ]);
    expect(entries()[0].querySelector(".agent-avatar-status.is-blocked")).not.toBeNull();
    act(() => entries()[1].click());
    expect(opened).toEqual([["p2", "Paginate audit log"]]);
    // It leads into the session and offers nothing that answers the agent there.
    expect(container.querySelectorAll("button")).toHaveLength(4);
  });

  test("a finished session is listed as finished, and the heading stops saying everyone waits", () => {
    act(() => root!.render(<DeskEmptyView attention={[session("p1", "Review swipes"), session("p2", "Validate types", "done")]} hasSessions state={null}
      create={null} shortcut={false} onOpen={() => undefined} onCreate={() => undefined} onSearch={() => undefined} onAction={() => undefined} />));
    expect(container.querySelector(".desk-empty-title")?.textContent).toBe(t("deskEmpty.needsYou", { count: "2" }));
    expect(entries().map((entry) => entry.className)).toEqual(["desk-ticket is-blocked", "desk-ticket is-done"]);
    expect(entries()[1].querySelector(".desk-ticket-status.is-done")?.textContent).toBe(t("status.done"));
  });

  test("with nobody to attend to it keeps the short prompt and the two buttons", () => {
    const fired: string[] = [];
    act(() => root!.render(<DeskEmptyView attention={[]} hasSessions state={null} create={{ disabled: false }} shortcut={false}
      onOpen={() => undefined} onCreate={() => fired.push("create")} onSearch={() => fired.push("search")} onAction={(kind) => fired.push(kind)} />));
    expect(container.querySelector(".empty-title")?.textContent).toBe(t("desk.pickTitle"));
    expect(container.querySelector(".empty-sub")?.textContent).toBe(t("desk.pickSub"));
    expect(entries()).toEqual([]);
    expect(actions().map((button) => button.textContent)).toEqual([t("empty.actionCreate"), t("deskEmpty.search")]);
    act(() => { for (const button of actions()) button.click(); });
    expect(fired).toEqual(["create", "search"]);
  });

  test("a computer with no session yet gets its heading, one line and the one primary action", () => {
    const fired: string[] = [];
    act(() => root!.render(<DeskEmptyView attention={[]} hasSessions={false}
      state={{ title: "No sessions on studio yet", sub: "Start one here.", command: "", actions: [], entries: "open" }}
      create={{ disabled: false }} shortcut={false}
      onOpen={() => undefined} onCreate={() => fired.push("create")} onSearch={() => fired.push("search")} onAction={(kind) => fired.push(kind)} />));
    const block = container.querySelector(".main-empty")!;
    expect([...block.children].map((node) => `${node.tagName.toLowerCase()}.${node.className}`))
      .toEqual(["h2.empty-title", "p.empty-sub", "div.desk-empty-actions"]);
    expect(block.querySelector("h2")?.textContent).toBe("No sessions on studio yet");
    expect(block.querySelector(".empty-sub")?.textContent).toBe("Start one here.");
    // It does not say to pick from a list that has nothing in it.
    expect(block.textContent).not.toContain(t("desk.pickTitle"));
    expect(actions().map((button) => [button.textContent, button.classList.contains("btn-primary")]))
      .toEqual([[t("empty.actionCreate"), true], [t("deskEmpty.search"), false]]);
    act(() => { for (const button of actions()) button.click(); });
    expect(fired).toEqual(["create", "search"]);
  });

  test("while the list is being read the same block stands with its buttons held, so nothing moves when it arrives", () => {
    const fired: string[] = [];
    const render = (create: { disabled: boolean } | null) => act(() => root!.render(<DeskEmptyView attention={[]} hasSessions={false}
      state={{ title: "Reading sessions", sub: "Connected.", command: "", actions: [], entries: "held" }} create={create} shortcut
      onOpen={() => undefined} onCreate={() => fired.push("create")} onSearch={() => fired.push("search")} onAction={(kind) => fired.push(kind)} />));
    render(null);
    const block = container.querySelector(".main-empty")!;
    expect([...block.children].map((node) => `${node.tagName.toLowerCase()}.${node.className}`))
      .toEqual(["h2.empty-title", "p.empty-sub", "div.desk-empty-actions"]);
    expect(block.querySelector("h2")?.getAttribute("role")).toBe("status");
    // Both entries are drawn before the capability is known, and neither answers.
    expect(actions().map((button) => [button.textContent, button.disabled]))
      .toEqual([[t("empty.actionCreate"), true], [`${t("deskEmpty.search")}⌘K`, true]]);
    act(() => { for (const button of actions()) button.click(); });
    render({ disabled: false });
    expect(actions().map((button) => button.disabled)).toEqual([true, true]);
    expect(fired).toEqual([]);
  });

  test("a list that cannot be read says why and offers its own ways out, never a new session", () => {
    const fired: string[] = [];
    act(() => root!.render(<DeskEmptyView attention={[]} hasSessions={false} create={{ disabled: false }} shortcut
      state={{ title: "Herdr isn't running", sub: "Run this on the computer.", command: "pairfob doctor", entries: "none",
        actions: [{ label: "Retry", kind: "retry", primary: false, disabled: false }, { label: "Details", kind: "details", primary: false, disabled: false }] }}
      onOpen={() => undefined} onCreate={() => fired.push("create")} onSearch={() => fired.push("search")} onAction={(kind) => fired.push(kind)} />));
    const block = container.querySelector(".main-empty")!;
    expect([...block.children].map((node) => `${node.tagName.toLowerCase()}.${node.className}`))
      .toEqual(["h2.empty-title", "p.empty-sub", "div.herd-empty-command", "div.desk-empty-actions"]);
    expect(block.querySelector("code")?.textContent).toBe("pairfob doctor");
    expect(actions().map((button) => button.textContent)).toEqual(["Retry", "Details"]);
    expect(block.querySelector(".btn-primary, .desk-empty-search")).toBeNull();
    act(() => { for (const button of actions()) button.click(); });
    expect(fired).toEqual(["retry", "details"]);
    // Offline or reconnecting mends itself: the two lines and nothing to press.
    act(() => root!.render(<DeskEmptyView attention={[]} hasSessions={false} create={{ disabled: true }} shortcut={false}
      state={{ title: "This device is offline", sub: "Sessions load once it is online.", command: "", actions: [], entries: "none" }}
      onOpen={() => undefined} onCreate={() => undefined} onSearch={() => undefined} onAction={() => undefined} />));
    expect([...container.querySelector(".main-empty")!.children].map((node) => node.className)).toEqual(["empty-title", "empty-sub"]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("create follows the rail: absent without the capability, disabled while it cannot run", () => {
    const render = (create: { disabled: boolean } | null, shortcut = false) => act(() => root!.render(
      <DeskEmptyView attention={[]} hasSessions state={null} create={create} shortcut={shortcut} onOpen={() => undefined} onCreate={() => undefined} onSearch={() => undefined} onAction={() => undefined} />));
    render(null);
    expect(actions().map((button) => button.textContent)).toEqual([t("deskEmpty.search")]);
    render({ disabled: true });
    expect(actions()[0].disabled).toBeTrue();
    expect(container.querySelector("kbd")).toBeNull();
    render({ disabled: true }, true);
    expect(actions()[1].querySelector("kbd")?.textContent).toBe("⌘K");
  });
});

describe("what an empty list means in the main column", () => {
  const input = { runtimeKind: "herdr", connected: true, createConversation: true, networkOnline: true, operationBusy: false,
    hostName: "studio", recentDirs: [] };
  const of = (overrides: Partial<typeof input>) => deskEmptyState({ groups: [], loading: false, empty: herdEmptyView({ ...input, ...overrides }) })!;

  test("rows, or a list not judged yet, are nothing to explain", () => {
    expect(deskEmptyState({ groups: [{}] as never, loading: false, empty: null })).toBeNull();
    expect(deskEmptyState({ groups: [], loading: false, empty: null })).toBeNull();
  });

  test("still reading: its own words, the entries held", () => {
    expect(deskEmptyState({ groups: [], loading: true, empty: null })).toEqual(
      { title: t("deskEmpty.readingTitle"), sub: t("deskEmpty.readingSub"), command: "", actions: [], entries: "held" });
  });

  test("nothing here yet: the computer's heading and the desk's one line, the entries open", () => {
    expect(of({})).toEqual({ title: t("empty.hostTitle", { host: "studio" }), sub: t("deskEmpty.firstSub"), command: "", actions: [], entries: "open" });
    expect(of({ createConversation: false })).toEqual(
      { title: t("empty.hostTitle", { host: "studio" }), sub: t("deskEmpty.firstOpenSub"), command: "herdr", actions: [], entries: "open" });
  });

  test("Herdr gone or silent: the list's own title, line, command and ways out, and no way to start a session", () => {
    const gone = of({ runtimeKind: "offline" });
    expect(gone).toMatchObject({ title: t("empty.exitedTitle"), sub: t("empty.exitedSub"), command: "pairfob doctor", entries: "none" });
    expect(gone.actions.map((action) => action.kind)).toEqual(["retry"]);
    const silent = of({ runtimeKind: "" });
    expect(silent).toMatchObject({ title: t("empty.unverifiedTitle"), sub: t("empty.unverifiedSub"), command: "", entries: "none" });
    expect(silent.actions.map((action) => action.kind)).toEqual(["retry", "details"]);
    for (const state of [gone, silent]) expect(state.actions.some((action) => action.kind === "create")).toBeFalse();
  });

  test("offline and reconnecting: what is happening and what follows, nothing to press", () => {
    expect(of({ networkOnline: false, connected: false })).toEqual(
      { title: t("deskEmpty.offlineTitle"), sub: t("empty.offlineNote", { host: "studio" }), command: "", actions: [], entries: "none" });
    expect(of({ connected: false })).toEqual(
      { title: t("empty.reconnectingTitle"), sub: t("empty.reconnectNote"), command: "", actions: [], entries: "none" });
  });
});

describe("desk empty over the live herd", () => {
  test("it lists what the needs-you strip lists: waiting first, then finished, never a working session", () => {
    act(() => root!.render(<DeskEmpty />));
    expect(container.querySelector(".desk-empty-title")?.textContent).toBe(t("deskEmpty.needsYou", { count: "2" }));
    expect(entries().map((entry) => entry.dataset.paneId)).toEqual(["ask", "fin"]);
    expect(entries()[0].querySelector(".desk-ticket-name")?.textContent).toBe("ask");
    expect(entries()[0].querySelector(".desk-ticket-meta")?.textContent).toBe(`${t("status.blocked")} · codex · pairfob · implementation`);
    expect(actions()[0].disabled).toBeFalse();
  });

  test("it follows the domains without a repaint", () => {
    act(() => root!.render(<DeskEmpty />));
    act(() => {
      batch(() => {
        seed({ ask: "working", fin: "idle", run: "working" });
        setOperationBusy(true);
      });
      publishAllDomains();
    });
    expect(entries()).toEqual([]);
    expect(container.querySelector(".empty-title")?.textContent).toBe(t("desk.pickTitle"));
    expect(actions()[0].disabled).toBeTrue();
    act(() => {
      batch(() => {
        applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
        seed({});
      });
      publishAllDomains();
    });
    // No session left and no way to start one from here: the first-run words for that, and search alone.
    expect(actions().map((button) => button.textContent)).toEqual([t("deskEmpty.search")]);
    expect(container.querySelector("h2.empty-title")?.textContent).toBe(t("empty.hostTitle", { host: t("settings.currentComputer") }));
    expect(container.querySelector(".empty-sub")?.textContent).toBe(t("deskEmpty.firstOpenSub"));
    act(() => {
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, []);
      publishAllDomains();
    });
    expect(container.querySelector(".empty-sub")?.textContent).toBe(t("deskEmpty.firstSub"));
    expect(actions().map((button) => button.textContent)).toEqual([t("empty.actionCreate"), t("deskEmpty.search")]);
    expect(container.querySelectorAll(".btn-primary")).toHaveLength(1);
  });

  test("search opens the palette over the same herd, the waiting session first", () => {
    act(() => root!.render(<DeskEmpty />));
    act(() => actions()[1].click());
    const palette = document.querySelector<HTMLDialogElement>("dialog.command-palette")!;
    expect(palette.open).toBeTrue();
    const rows = [...palette.querySelectorAll<HTMLElement>("[role=option]")];
    expect(rows[0].dataset.paneId).toBe("ask");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows.filter((row) => row.dataset.paneId).map((row) => row.dataset.paneId)).toEqual(["ask", "fin", "run"]);
  });
});
