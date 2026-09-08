import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { act } from "react";
import { leaveReactScreen } from "./react/root";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorktreeJobDriver } from "../lib/worktree-jobs.ts";

const { setLang } = await import("../lib/i18n.ts");
const { app, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderApp } = await import("./react/app-screen");
function renderHome(): void { act(renderApp); }
const { t } = await import("../lib/i18n.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../lib/operations.ts");
const { dismissWorktreeJob, startWorktreeJob, worktreeJobs } = await import("../lib/worktree-jobs.ts");

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeDriver(): { driver: WorktreeJobDriver; pendings: Deferred<never>[] } {
  const pendings: Deferred<never>[] = [];
  const driver: WorktreeJobDriver = {
    create: (() => {
      const wait = deferred<never>();
      pendings.push(wait);
      return wait.promise;
    }) as WorktreeJobDriver["create"],
    refresh: async () => undefined,
    openPane: async () => undefined,
    reconcile: async () => undefined,
    messageOf: (error) => (error instanceof Error ? error.message : String(error)),
    repaint: () => renderHome(),
  };
  return { driver, pendings };
}

function boot(): void {
  state.phase = "live";
  state.screen = "home";
  state.paneId = "";
  state.listGroup = "flat";
  state.panePinned = {};
  state.operationBusy = false;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES, create_conversation: true, create_worktree: true };
  state.agents = [
    {
      paneId: "p1",
      agent: "claude",
      status: "idle",
      workspaceLabel: "alpha",
      cwd: "/tmp/a",
      workspaceId: "w1",
      tabId: "t1",
      tabLabel: "main",
      paneLabel: "one",
    },
  ];
  state.live = { isConnected: () => true };
  setRenderer(() => renderHome());
  renderHome();
}

function createButton(): HTMLButtonElement {
  const create = app.querySelector(".topbar-create");
  if (!(create instanceof happy.HTMLButtonElement)) throw new Error("missing New button");
  return create as HTMLButtonElement;
}

function settle(): Promise<void> {
  return act(async () => { await new Promise<void>(resolve => window.setTimeout(resolve, 0)); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  Object.assign(state, { phase: "live", screen: "home", fullTerminal: false, agentChat: false,
    credential: null, live: null, computers: [], agents: [], paneId: "", panePinned: {}, paneTouched: {},
    listGroup: "flat", listGroupCollapsed: {}, operationBusy: false, networkOnline: true, runtimeKind: "herdr",
    herdHost: "", notice: null, settingsLoading: false, deviceList: [], devicesError: "", pushConfigError: "",
    pushEnabled: null, pushSubscribed: null });
  setLang("zh");
});

afterEach(() => {
  act(() => {
    for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
    leaveReactScreen();
  });
  setRenderer(() => {});
  state.live = null;
  state.agents = [];
  state.paneId = "";
  state.listGroup = "flat";
  state.panePinned = {};
  state.operationBusy = false;
  state.notice = null;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  app.replaceChildren();
});

describe("worktree progress cards on home", () => {
  test("a working job renders a progress row and does not disable New", () => {
    boot();
    const { driver } = fakeDriver();
    startWorktreeJob(driver, { workspace_id: "w1", branch: "feat/x", label: "hotfix" });
    renderHome();

    const card = app.querySelector(".worktree-job");
    expect(Boolean(card)).toBe(true);
    expect(card?.textContent).toContain("hotfix");
    expect(card?.textContent).toContain("feat/x");
    expect(card?.textContent).toContain(t("op.creatingWorktree"));
    expect(Boolean(card?.querySelector(".spinner"))).toBe(true);
    expect(createButton().disabled).toBe(false);
    expect(state.operationBusy).toBe(false);
  });

  test("operationBusy from other operations still disables New", () => {
    boot();
    const { driver } = fakeDriver();
    startWorktreeJob(driver, { workspace_id: "w1" });
    renderHome();
    expect(createButton().disabled).toBe(false);

    state.operationBusy = true;
    renderHome();
    expect(createButton().disabled).toBe(true);
  });

  test("cards render above an empty session list and in the wide rail", () => {
    boot();
    state.agents = [];
    const { driver } = fakeDriver();
    startWorktreeJob(driver, { workspace_id: "w1" });
    renderHome();
    expect(Boolean(app.querySelector(".worktree-job"))).toBe(true);

    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    renderHome();
    const rail = app.querySelector(".rail")!;
    expect(Boolean(rail.querySelector(".worktree-job"))).toBe(true);
  });

  test("cancel removes a working card and a late result stays ignored", async () => {
    boot();
    const { driver, pendings } = fakeDriver();
    startWorktreeJob(driver, { workspace_id: "w1" });
    renderHome();

    const cancel = app.querySelector(".worktree-job button");
    expect(cancel?.textContent).toBe(t("cancel"));
    act(() => { (cancel as HTMLButtonElement).click(); });
    expect((app.querySelector(".worktree-job")) === null).toBe(true);

    pendings[0].resolve(undefined as never);
    await settle();
    expect((app.querySelector(".worktree-job")) === null).toBe(true);
    expect(worktreeJobs()).toHaveLength(0);
  });

  test("a failed card offers retry (fresh call) and dismiss", async () => {
    boot();
    const fake = fakeDriver();
    const job = startWorktreeJob(fake.driver, { workspace_id: "w1" });
    renderHome();

    fake.pendings[0].reject(new Error("git fetch failed"));
    await settle();
    renderHome();

    const card = app.querySelector(".worktree-job");
    expect(Boolean(card)).toBe(true);
    expect(card?.textContent).toContain("git fetch failed");
    expect((card?.querySelector(".spinner")) === null).toBe(true);

    const buttons = [...(card?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
    const retry = buttons.find((item) => item.textContent === t("retry"));
    const dismiss = buttons.find((item) => item.textContent === t("dismiss"));
    expect(Boolean(retry)).toBe(true);
    expect(Boolean(dismiss)).toBe(true);

    act(() => { retry?.click(); });
    expect(fake.pendings).toHaveLength(2);
    expect(worktreeJobs()[0]?.status).toBe("working");
    expect(worktreeJobs()[0]?.id).toBe(job?.id);

    fake.pendings[1].reject(new Error("still broken"));
    await settle();
    renderHome();
    const failedAgain = app.querySelector(".worktree-job");
    expect(failedAgain?.textContent).toContain("still broken");
    const dismissAgain = [...(failedAgain?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent === t("dismiss"),
    ) as HTMLButtonElement | undefined;
    act(() => { dismissAgain?.click(); });
    expect(worktreeJobs()).toHaveLength(0);
    expect((app.querySelector(".worktree-job")) === null).toBe(true);
  });
});
