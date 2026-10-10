import { expectSameNode } from "../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { LiveSession } from "../../lib/protocol/client";
import { ProtocolError } from "../../lib/protocol/errors";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { setLang, t } from "../../lib/i18n";
import { dismissWorktreeJob, startWorktreeJob, worktreeJobs, type WorktreeJobDriver } from "../../lib/worktree-jobs";
import { mountApp, unmountApp } from "../../app/mount";
import { commitView } from "../../app/host";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { setScreen } from "../../app/navigation-store";
import { clearNotice } from "../../app/notices-store";
import { registerSessionView } from "../session/register";
import { attachLiveSession, setComputers, setCredential } from "../computers/catalog-store";
import { setNetworkOnline, setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { DIALOG_STEP, ModalFrame, presentModal } from "../../shared/ui/overlay/modal";
import { applyCapabilities, setOperationBusy } from "./capabilities-store";
import { createSelectedWorktree, listSelectedWorktrees, openSelectedWorktree, operationGate } from "./controller";
import { followWorktreeJob } from "./worktree-outcome";
import { runDialogStep } from "./worktree-steps";

/**
 * The Worktree actions asked from outside the session panel (the branches
 * dialog beside the files). The two forms are the panel's own, in a dialog
 * that runs them in place: the desk card beside the list, the bottom sheet
 * under a finger. Each says how it ended, so the dialog that asked can stay
 * open under it and close only once something was done.
 */
const settle = () => act(async () => { await new Promise<void>(resolve => window.setTimeout(resolve, 0)); });
const dialogs = () => [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
const shared = () => document.querySelector<HTMLDialogElement>("dialog.worktree-form-sheet[open]");
const legacy = () => document.querySelector<HTMLDialogElement>("dialog.operation-modal[open]");
let release = () => {};
let created: Array<Record<string, unknown>> = [];
let opened: Array<Record<string, unknown>> = [];
let create: () => Promise<unknown> = async () => ({ pane_id: "p1" });

function enter(target: Element): void {
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event); });
}
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}
/** A mouse or the keyboard on a desk layout. */
function onDesk(): void {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  release = bindOverlayOrigin(document);
  document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
}

function boot(): void {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, list_worktrees: true, create_worktree: true, open_worktree: true }, []);
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "alpha", cwd: "/work/alpha" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "claude", agent_status: "idle", cwd: "/work/alpha" }],
  });
  attachLiveSession({
    isConnected: () => true,
    snapshot: async () => ({ workspaces: [{ workspace_id: "w1", label: "alpha" }], panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "claude", agent_status: "idle", cwd: "/work/alpha" }] }),
    paneRead: async () => ({ text: "", hash: "h" }),
    createWorktree: (input: Record<string, unknown>) => { created.push(input); return create(); },
    openWorktree: async (input: Record<string, unknown>) => { opened.push(input); return { pane_id: "p1", workspace_id: "w1" }; },
    listWorktrees: async () => ({ worktrees: [] }),
  } as unknown as LiveSession);
  selectPane("p1");
  act(() => { mountApp(); commitView(); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  setLang("zh");
  registerSessionOwnerPreparer(registerSessionView);
  attachLiveSession(null);
  setCredential(null);
  setComputers([]);
  setPhase("live");
  setScreen("home");
  setFullTerminal(false);
  setAgentChat(false);
  setNetworkOnline(true);
  setOperationBusy(false);
  clearNotice();
  created = [];
  opened = [];
  create = async () => ({ pane_id: "p1" });
});
afterEach(async () => {
  await act(async () => {
    for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
    closeTestDialogs();
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  });
  act(() => unmountApp());
  attachLiveSession(null);
  release();
  release = () => {};
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("beside the list, new Worktree is the panel's form in a dialog: it follows the job and closes on the result", async () => {
  onDesk();
  boot();
  let finish!: (value: unknown) => void;
  create = () => new Promise(resolve => { finish = resolve; });
  const done: boolean[] = [];
  act(() => { void createSelectedWorktree(started => done.push(started)); });
  expect(legacy()).toBeNull();
  const dialog = shared()!;
  expect(dialog.querySelector("h2")?.textContent).toBe(t("pm.wtNew"));
  expect(dialog.querySelector(".create-summary")?.textContent).toBe(t("pm.wtCreateSummary", { dir: "/work/alpha" }));
  type(dialog.querySelector<HTMLInputElement>('input[name="branch"]')!, "feat/keys");
  enter(dialog.querySelector<HTMLInputElement>('input[name="branch"]')!);
  await settle();
  expect(created).toEqual([{ workspace_id: "w1", branch: "feat/keys" }]);
  expect(worktreeJobs()).toHaveLength(1);
  const primary = dialog.querySelector<HTMLButtonElement>(".create-submit")!;
  expect(primary.textContent).toBe(t("pm.wtCreateStarted"));
  expectSameNode(document.activeElement, primary);
  await act(async () => { finish({ pane_id: "p1" }); await new Promise<void>(resolve => window.setTimeout(resolve, 0)); });
  await settle();
  expect(done).toEqual([true]);
  expect(shared()).toBeNull();
  expect(worktreeJobs()).toHaveLength(0);
});

test("a create that fails is reported on the form, which is the reader's again", async () => {
  onDesk();
  boot();
  create = async () => { throw new ProtocolError("conflict", "branch exists"); };
  // Asked with nobody listening for how it ends, as a plain row does.
  act(() => { void createSelectedWorktree(); });
  const dialog = shared()!;
  const branch = dialog.querySelector<HTMLInputElement>('input[name="branch"]')!;
  type(branch, "main");
  enter(branch);
  await settle();
  await settle();
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(dialog.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBeFalse();
  expectSameNode(document.activeElement, branch);
  // The card in the list keeps its own retry.
  expect(worktreeJobs().map(job => job.status)).toEqual(["failed"]);
});

test("beside the list, open Worktree refuses an empty target in the field and opens by branch", async () => {
  onDesk();
  boot();
  const done: boolean[] = [];
  act(() => { void openSelectedWorktree(opened => done.push(opened)); });
  const dialog = shared()!;
  expect(dialog.querySelector("h2")?.textContent).toBe(t("menu.openWorktree"));
  const target = dialog.querySelector<HTMLInputElement>('input[name="target"]')!;
  enter(target);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(t("form.needPathOrBranch"));
  expectSameNode(document.activeElement, target);
  expect(opened).toEqual([]);
  type(target, "feat/keys");
  enter(target);
  await settle();
  await settle();
  expect(opened).toEqual([{ workspace_id: "w1", branch: "feat/keys" }]);
  expect(done).toEqual([true]);
});

test("put away, a form says so; opened over a dialog that stays, it is that dialog's step", async () => {
  onDesk();
  boot();
  act(() => { presentModal<void>(modal => createElement(ModalFrame<void>, { modal, title: "Branches", children: createElement("button", { type: "button" }, "New Worktree") })); });
  const done: boolean[] = [];
  act(() => { void openSelectedWorktree(opened => done.push(opened)); });
  expect(dialogs()).toHaveLength(2);
  expect(shared()!.classList.contains(DIALOG_STEP)).toBeTrue();
  act(() => shared()!.querySelector<HTMLButtonElement>(".desk-cancel")!.click());
  await settle();
  expect(done).toEqual([false]);
  expect(dialogs().map(dialog => dialog.querySelector("h2")?.textContent)).toEqual(["Branches"]);

  // The list resolves once it is read, and says how it went away to whoever asked.
  const closed: boolean[] = [];
  await act(async () => { await listSelectedWorktrees(opened => closed.push(opened)); });
  const list = legacy()!;
  expect(list.classList.contains(DIALOG_STEP)).toBeTrue();
  expect(closed).toEqual([]);
  act(() => list.querySelector<HTMLButtonElement>(".worktree-close")!.click());
  await settle();
  expect(closed).toEqual([false]);
});

test("a step run from a dialog's row keeps that dialog until something was done, the list on a finger's sheet included", async () => {
  onDesk();
  boot();
  const calls: string[] = [];
  // Beside the list: the step opens at once, over a dialog that is not closed for it.
  runDialogStep(openSelectedWorktree, () => calls.push("close"));
  await settle();
  expect(calls).toEqual([]);
  expect(shared()).not.toBeNull();
  act(() => shared()!.querySelector<HTMLButtonElement>(".desk-cancel")!.click());
  await settle();
  // Put away: the dialog that asked stays.
  expect(calls).toEqual([]);
  runDialogStep(openSelectedWorktree, () => calls.push("close"));
  await settle();
  const target = shared()!.querySelector<HTMLInputElement>('input[name="target"]')!;
  type(target, "feat/keys");
  enter(target);
  await settle();
  await settle();
  // Done: now it closes.
  expect(calls).toEqual(["close"]);

  // A finger: a step is still a step, over a sheet that is not closed for it.
  release();
  release = () => {};
  const order: string[] = [];
  runDialogStep(closed => { order.push("step"); closed(false); }, () => order.push("close"));
  expect(order).toEqual(["step"]);
  runDialogStep(closed => { order.push("done"); closed(true); }, () => order.push("close"));
  expect(order).toEqual(["step", "done", "close"]);
  // The list is a step like the forms: the sheet that asked stays under it,
  // and is closed only by a Worktree opened from the list.
  order.length = 0;
  act(() => { presentModal<void>(modal => createElement(ModalFrame<void>, { modal, title: "Branches", children: createElement("button", { type: "button" }, "Worktree list") })); });
  await act(async () => { runDialogStep(listSelectedWorktrees, () => order.push("closed for the list")); await settle(); });
  const list = legacy()!;
  expect(list.querySelector("h2")?.textContent).toBe(t("menu.worktrees"));
  expect(list.classList.contains(DIALOG_STEP)).toBeTrue();
  act(() => list.querySelector<HTMLButtonElement>(".worktree-close")!.click());
  await settle();
  expect(order).toEqual([]);
  expect(dialogs().map(dialog => dialog.querySelector("h2")?.textContent)).toEqual(["Branches"]);
});

test("a finger gets the same two forms in a bottom sheet, over the sheet that offered them", async () => {
  boot();
  // The sheet a row of which asks: it stays open under the form.
  act(() => { presentModal<void>(modal => createElement(ModalFrame<void>, { modal, title: "Branches", children: createElement("button", { type: "button" }, "New Worktree") })); });
  const calls: string[] = [];
  runDialogStep(createSelectedWorktree, () => calls.push("close"));
  await settle();
  expect(legacy()).toBeNull();
  const form = shared()!;
  expect(form.className).toBe(`modal sheet worktree-form-sheet ${DIALOG_STEP}`);
  expect(form.querySelector("h2")?.textContent).toBe(t("pm.wtNew"));
  expect([...form.querySelectorAll("input")].map(input => `${input.name}:${input.placeholder}`)).toEqual([
    `branch:${t("create.branchHint")}`, `base:${t("create.baseHint")}`, `label:${t("pm.wtNameHint")}`, `path:${t("create.pathPlaceholder")}`]);
  // The sheet's own anatomy: the close control in its head, the action pinned in the scroller, no desk footer.
  expect(form.querySelector(".desk-cancel")).toBeNull();
  expect(form.querySelector(".sheet-foot")).toBeNull();
  expect(form.querySelector(".sheet-head .sheet-close")).not.toBeNull();
  expect(form.querySelector(".sheet-body .create-footer .create-submit")?.textContent).toBe(t("pm.wtCreate"));
  // Put away, it undoes that one step: the sheet beneath is still there and was not asked to close.
  act(() => form.querySelector<HTMLButtonElement>(".sheet-close")!.click());
  await settle();
  expect(calls).toEqual([]);
  expect(dialogs().map(dialog => dialog.querySelector("h2")?.textContent)).toEqual(["Branches"]);

  // The form follows its job: it says the create is under way, and closes both once the Worktree exists.
  let finish!: (value: unknown) => void;
  create = () => new Promise(resolve => { finish = resolve; });
  runDialogStep(createSelectedWorktree, () => calls.push("close"));
  await settle();
  const again = shared()!;
  act(() => again.querySelector<HTMLButtonElement>(".create-submit")!.click());
  await settle();
  expect(created).toEqual([{ workspace_id: "w1" }]);
  const primary = again.querySelector<HTMLButtonElement>(".create-submit")!;
  expect(primary.textContent).toBe(t("pm.wtCreateStarted"));
  expect(again.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBeTrue();
  expect(calls).toEqual([]);
  await act(async () => { finish({ pane_id: "p1" }); await new Promise<void>(resolve => window.setTimeout(resolve, 0)); });
  await settle();
  expect(shared()).toBeNull();
  expect(calls).toEqual(["close"]);

  // Open: one target, refused empty with the reason on the form, then opened by branch.
  const found: boolean[] = [];
  act(() => { void openSelectedWorktree(opened => found.push(opened)); });
  const open = shared()!;
  expect(open.classList.contains("desk-form")).toBeFalse();
  expect([...open.querySelectorAll("input")].map(input => input.name)).toEqual(["target"]);
  const go = open.querySelector<HTMLButtonElement>(".create-submit")!;
  expect(go.textContent).toBe(t("pm.wtOpen"));
  go.focus();
  act(() => go.click());
  expect(open.querySelector('[role="alert"]')?.textContent).toBe(t("form.needPathOrBranch"));
  expectSameNode(document.activeElement, go);
  expect(opened).toEqual([]);
  type(open.querySelector<HTMLInputElement>('input[name="target"]')!, "feat/keys");
  act(() => go.click());
  await settle();
  await settle();
  expect(opened).toEqual([{ workspace_id: "w1", branch: "feat/keys" }]);
  expect(found).toEqual([true]);
  expect(shared()).toBeNull();
});

test("a create that fails under a finger is said on the sheet, which is the reader's again", async () => {
  boot();
  create = async () => { throw new ProtocolError("conflict", "branch exists"); };
  const made: boolean[] = [];
  act(() => { void createSelectedWorktree(started => made.push(started)); });
  const form = shared()!;
  const primary = form.querySelector<HTMLButtonElement>(".create-submit")!;
  primary.focus();
  act(() => primary.click());
  await settle();
  await settle();
  expect(form.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(form.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBeFalse();
  expect(primary.textContent).toBe(t("pm.wtCreate"));
  expectSameNode(document.activeElement, primary);
  expect(made).toEqual([]);
  expect(shared()).not.toBeNull();
});

test("the gate says why an operation cannot run right now, and tells those who follow it", () => {
  boot();
  let told = 0;
  const stop = operationGate.subscribe(() => { told += 1; });
  expect(operationGate.read()).toBe("");
  act(() => setOperationBusy(true));
  expect(operationGate.read()).toBe(t("boardMenu.busy"));
  act(() => { setOperationBusy(false); setNetworkOnline(false); });
  expect(operationGate.read()).toBe(t("boardMenu.offline"));
  expect(told).toBeGreaterThanOrEqual(3);
  stop();
  act(() => setNetworkOnline(true));
});

test("a followed job settles once: created, failed with its reason, or dropped with none", async () => {
  const stub = (createJob: WorktreeJobDriver["create"]): WorktreeJobDriver => ({
    create: createJob, refresh: async () => undefined, openPane: async () => undefined, reconcile: async () => undefined,
    messageOf: error => error instanceof Error ? error.message : String(error), repaint: () => undefined,
  });
  const ok = followWorktreeJob(stub(async () => ({ pane_id: "p9" }) as never));
  expect(await ok.outcome(startWorktreeJob(ok.driver, { workspace_id: "w1" })!)).toEqual({ ok: true });

  const bad = followWorktreeJob(stub(async () => { throw new Error("no room"); }));
  const failed = startWorktreeJob(bad.driver, { workspace_id: "w1" })!;
  expect(await bad.outcome(failed)).toEqual({ ok: false, message: "no room" });
  dismissWorktreeJob(failed.id);

  const gone = followWorktreeJob(stub(() => new Promise(() => undefined)));
  const dropped = startWorktreeJob(gone.driver, { workspace_id: "w1" })!;
  const outcome = gone.outcome(dropped);
  dismissWorktreeJob(dropped.id);
  expect(await outcome).toEqual({ ok: false, message: "" });
});
