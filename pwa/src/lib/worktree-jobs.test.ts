import { afterEach, describe, expect, test } from "bun:test";
import type { CreateWorktreeInput, CreateWorktreeResult } from "./operations";
import {
  WORKTREE_JOB_LIMIT,
  dismissWorktreeJob,
  retryWorktreeJob,
  startWorktreeJob,
  worktreeJobs,
  type WorktreeJobDriver,
} from "./worktree-jobs";

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

function appliedResult(paneId: string): CreateWorktreeResult {
  return {
    operation_id: "op_AAECAwQFBgcICQoL",
    workspace_id: "w1",
    tab_id: "t1",
    pane_id: paneId,
    path: "/tmp/work",
    branch: null,
    outcome: "applied",
  };
}

function fakeDriver(): {
  driver: WorktreeJobDriver;
  events: string[];
  calls: CreateWorktreeInput[];
  pendings: Deferred<CreateWorktreeResult>[];
} {
  const events: string[] = [];
  const calls: CreateWorktreeInput[] = [];
  const pendings: Deferred<CreateWorktreeResult>[] = [];
  const driver: WorktreeJobDriver = {
    create: (input) => {
      calls.push(input);
      const wait = deferred<CreateWorktreeResult>();
      pendings.push(wait);
      return wait.promise;
    },
    refresh: async () => {
      events.push("refresh");
    },
    openPane: async (paneId) => {
      events.push(`open:${paneId}`);
    },
    reconcile: async () => {
      events.push("reconcile");
    },
    messageOf: (error) => (error instanceof Error ? error.message : String(error)),
    repaint: () => {
      events.push("repaint");
    },
    succeeded: () => {
      events.push("notice");
    },
  };
  return { driver, events, calls, pendings };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
});

describe("worktree job machine", () => {
  test("start → success refreshes then opens the created pane and drops the card", async () => {
    const { driver, events, pendings } = fakeDriver();
    const job = startWorktreeJob(driver, { workspace_id: "w1", branch: "feat/x" });
    expect(job).not.toBeNull();
    expect(worktreeJobs()).toHaveLength(1);
    expect(worktreeJobs()[0].status).toBe("working");
    expect(events).toContain("repaint");

    pendings[0].resolve(appliedResult("p9"));
    await settle();

    expect(worktreeJobs()).toHaveLength(0);
    const refreshAt = events.indexOf("refresh");
    const openAt = events.indexOf("open:p9");
    expect(refreshAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(refreshAt);
    expect(events).toContain("notice");
  });

  test("start → failure keeps the card with the error", async () => {
    const { driver, events, pendings } = fakeDriver();
    const job = startWorktreeJob(driver, { workspace_id: "w1" });
    expect(job).not.toBeNull();

    pendings[0].reject(new Error("git fetch failed"));
    await settle();

    expect(worktreeJobs()).toHaveLength(1);
    expect(worktreeJobs()[0].status).toBe("failed");
    expect(worktreeJobs()[0].error).toBe("git fetch failed");
    expect(job?.attempts).toBe(1);
    expect(events).toContain("reconcile");
    expect(events.some((event) => event.startsWith("open:"))).toBe(false);
  });

  test("retry issues a fresh create call and never resends an operation id", async () => {
    const { driver, calls, pendings } = fakeDriver();
    const job = startWorktreeJob(driver, { workspace_id: "w1", label: "hotfix" });
    expect(job).not.toBeNull();
    pendings[0].reject(new Error("boom"));
    await settle();
    expect(worktreeJobs()[0].status).toBe("failed");

    retryWorktreeJob(job!.id);
    expect(worktreeJobs()[0].status).toBe("working");
    expect(worktreeJobs()[0].error).toBe("");
    expect(calls).toHaveLength(2);
    // The machine never stores mutation ids; every attempt is a new call, so
    // the session layer mints a fresh operation_id each time.
    for (const call of calls) expect("operation_id" in call).toBe(false);

    pendings[1].resolve(appliedResult("p10"));
    await settle();
    expect(job?.attempts).toBe(2);
    expect(worktreeJobs()).toHaveLength(0);
  });

  test("retry only acts on failed jobs", async () => {
    const { driver, calls, pendings } = fakeDriver();
    const job = startWorktreeJob(driver, { workspace_id: "w1" });
    expect(job).not.toBeNull();
    retryWorktreeJob(job!.id);
    expect(calls).toHaveLength(1);
    pendings[0].resolve(appliedResult("p11"));
    await settle();
  });

  test("cancel drops the card and ignores a late success", async () => {
    const { driver, events, pendings } = fakeDriver();
    const job = startWorktreeJob(driver, { workspace_id: "w1" });
    expect(job).not.toBeNull();

    dismissWorktreeJob(job!.id);
    expect(worktreeJobs()).toHaveLength(0);

    pendings[0].resolve(appliedResult("p12"));
    await settle();

    expect(worktreeJobs()).toHaveLength(0);
    expect(events.some((event) => event.startsWith("open:"))).toBe(false);
    expect(events).not.toContain("notice");
  });

  test("cancel drops the card and ignores a late failure", async () => {
    const { driver, pendings } = fakeDriver();
    const job = startWorktreeJob(driver, { workspace_id: "w1" });
    expect(job).not.toBeNull();

    dismissWorktreeJob(job!.id);
    pendings[0].reject(new Error("late"));
    await settle();

    expect(worktreeJobs()).toHaveLength(0);
  });

  test(`at most ${WORKTREE_JOB_LIMIT} jobs run at once`, () => {
    const { driver } = fakeDriver();
    for (let index = 0; index < WORKTREE_JOB_LIMIT; index += 1) {
      expect(startWorktreeJob(driver, { workspace_id: "w1" })).not.toBeNull();
    }
    expect(startWorktreeJob(driver, { workspace_id: "w1" })).toBeNull();
    expect(worktreeJobs()).toHaveLength(WORKTREE_JOB_LIMIT);
  });
});
