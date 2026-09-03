import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";
import type { WorktreeJobDriver } from "../lib/worktree-jobs.ts";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
  "MouseEvent",
  "PointerEvent",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.history = happy.history;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderHome, renderRail } = await import("./home.ts");
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
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
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
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("hotfix");
    expect(card?.textContent).toContain("feat/x");
    expect(card?.textContent).toContain(t("op.creatingWorktree"));
    expect(card?.querySelector(".spinner")).toBeTruthy();
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
    expect(app.querySelector(".worktree-job")).toBeTruthy();

    const rail = renderRail();
    expect(rail.querySelector(".worktree-job")).toBeTruthy();
  });

  test("cancel removes a working card and a late result stays ignored", async () => {
    boot();
    const { driver, pendings } = fakeDriver();
    startWorktreeJob(driver, { workspace_id: "w1" });
    renderHome();

    const cancel = app.querySelector(".worktree-job button");
    expect(cancel?.textContent).toBe(t("cancel"));
    (cancel as HTMLButtonElement).click();
    expect(app.querySelector(".worktree-job")).toBeNull();

    pendings[0].resolve(undefined as never);
    await settle();
    expect(app.querySelector(".worktree-job")).toBeNull();
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
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("git fetch failed");
    expect(card?.querySelector(".spinner")).toBeNull();

    const buttons = [...(card?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
    const retry = buttons.find((item) => item.textContent === t("retry"));
    const dismiss = buttons.find((item) => item.textContent === t("dismiss"));
    expect(retry).toBeTruthy();
    expect(dismiss).toBeTruthy();

    retry?.click();
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
    dismissAgain?.click();
    expect(worktreeJobs()).toHaveLength(0);
    expect(app.querySelector(".worktree-job")).toBeNull();
  });
});
