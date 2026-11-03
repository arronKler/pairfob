/* Background job machine for CreateWorktree. The RPC itself stays a blocking
 * mutation; this layer only stops the PWA from holding the global
 * `operationBusy` lock while `git fetch` + `worktree add` run. Jobs surface as
 * progress cards (features/operations/worktree-progress.tsx) instead of a modal status line.
 *
 * Rules kept here:
 * - Retry always issues a brand-new CreateWorktree call (fresh operation_id);
 *   the machine never stores or resends an operation id.
 * - Cancel is local only: the card is dropped and a late result is ignored.
 *   There is no cancel RPC; the next snapshot shows the workspace if the
 *   mutation still applied.
 */

import type { CreateWorktreeInput, CreateWorktreeResult } from "./operations";

export const WORKTREE_JOB_LIMIT = 3;

export type WorktreeJobStatus = "working" | "failed";

/** True while the session and target that started the job are still the live ones. */
export type WorktreeJobOwner = () => boolean;

export type WorktreeJob = {
  readonly id: number;
  readonly input: CreateWorktreeInput;
  /** Re-read on every retry and paint: a job belongs to one computer and one Herdr session. */
  readonly owns: WorktreeJobOwner;
  status: WorktreeJobStatus;
  /** CreateWorktree calls made for this job; retry always adds a fresh one. */
  attempts: number;
  error: string;
};

/** App side effects the machine needs, injected per job when it starts. */
export type WorktreeJobDriver = {
  create: (input: CreateWorktreeInput) => Promise<CreateWorktreeResult>;
  refresh: () => Promise<void>;
  openPane: (paneId: string) => Promise<void>;
  /** Read-only reconciliation (unknown_outcome & co.); never replays the mutation. */
  reconcile: (error: unknown) => Promise<void>;
  messageOf: (error: unknown) => string;
  repaint: () => void;
  succeeded?: () => void;
};

const jobs: WorktreeJob[] = [];
const drivers = new Map<number, WorktreeJobDriver>();
const alwaysOwned: WorktreeJobOwner = () => true;
let serial = 0;

export function worktreeJobs(): readonly WorktreeJob[] {
  return jobs;
}

/**
 * `owns` is the job's live owner check; absent in driver-only fixtures, where
 * there is no session or target that can move behind the job.
 */
export function startWorktreeJob(
  driver: WorktreeJobDriver,
  input: CreateWorktreeInput,
  owns: WorktreeJobOwner = alwaysOwned,
): WorktreeJob | null {
  if (jobs.length >= WORKTREE_JOB_LIMIT) return null;
  const job: WorktreeJob = { id: ++serial, input, owns, status: "working", attempts: 0, error: "" };
  jobs.push(job);
  drivers.set(job.id, driver);
  driver.repaint();
  void runWorktreeJob(job, driver);
  return job;
}

export type WorktreeRetry = "started" | "not-owner" | "ignored";

/**
 * Start a fresh attempt only while the job still belongs to the live session.
 * Retrying from another computer must never issue CreateWorktree there: its
 * effects could not be refreshed, opened or reported on the screen that asked.
 */
export function retryWorktreeJob(id: number): WorktreeRetry {
  const job = jobs.find((item) => item.id === id);
  const driver = drivers.get(id);
  if (!job || !driver || job.status !== "failed") return "ignored";
  // The target moved since the card painted Retry. Repaint so the card shows
  // where the job belongs instead of leaving a button that cannot work.
  if (!job.owns()) {
    driver.repaint();
    return "not-owner";
  }
  job.status = "working";
  job.error = "";
  driver.repaint();
  void runWorktreeJob(job, driver);
  return "started";
}

/** Dropping a working job is a local cancel: no RPC is sent and the late result is ignored. */
export function dismissWorktreeJob(id: number): void {
  const index = jobs.findIndex((item) => item.id === id);
  if (index === -1) return;
  const driver = drivers.get(id);
  jobs.splice(index, 1);
  drivers.delete(id);
  driver?.repaint();
}

function jobIsLive(job: WorktreeJob): boolean {
  return drivers.has(job.id) && jobs.includes(job);
}

async function runWorktreeJob(job: WorktreeJob, driver: WorktreeJobDriver): Promise<void> {
  job.attempts += 1;
  let result: CreateWorktreeResult;
  try {
    result = await driver.create(job.input);
  } catch (error) {
    if (!jobIsLive(job)) return;
    await settleFailure(job, driver, error);
    return;
  }
  // Cancelled while in flight: never auto-open or report a late result.
  if (!jobIsLive(job)) return;
  jobs.splice(jobs.indexOf(job), 1);
  drivers.delete(job.id);
  await settleSuccess(driver, result);
}

async function settleSuccess(driver: WorktreeJobDriver, result: CreateWorktreeResult): Promise<void> {
  try {
    // Refresh first so the open below sees the new pane in the snapshot.
    await driver.refresh();
    await driver.openPane(result.pane_id);
  } catch {
    /* The worktree exists; snapshot polling still surfaces it if open fails. */
  }
  driver.succeeded?.();
  driver.repaint();
}

async function settleFailure(job: WorktreeJob, driver: WorktreeJobDriver, error: unknown): Promise<void> {
  try {
    await driver.reconcile(error);
  } catch {
    /* keep the failure visible on the card below */
  }
  if (!jobIsLive(job)) return;
  job.status = "failed";
  job.error = driver.messageOf(error);
  driver.repaint();
}
