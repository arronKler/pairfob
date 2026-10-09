import { worktreeJobs, type WorktreeJob, type WorktreeJobDriver } from "../../lib/worktree-jobs";
import type { SheetOutcome } from "./operation-form-model";

/**
 * A background create job as the form that started it sees it.
 *
 * The job machine reports through its driver (a card in the list, a notice
 * when the Worktree exists). The form that asked stays open meanwhile and
 * needs the one answer: created, failed and why, or dropped from the list
 * (which is neither, so it carries no message). `follow` wraps a driver so the
 * same reports settle that answer; nothing is asked of the machine and a retry
 * from the card after a failure is the card's own business.
 */
export function followWorktreeJob(driver: WorktreeJobDriver): {
  driver: WorktreeJobDriver;
  /** The outcome of `job`, started with the wrapped driver. */
  outcome(job: WorktreeJob): Promise<SheetOutcome>;
} {
  let job: WorktreeJob | null = null;
  let created = false;
  let settle!: (outcome: SheetOutcome) => void;
  const settled = new Promise<SheetOutcome>(resolve => { settle = resolve; });
  const check = () => {
    if (!job) return;
    if (created) settle({ ok: true });
    else if (job.status === "failed") settle({ ok: false, message: job.error });
    else if (!worktreeJobs().includes(job)) settle({ ok: false, message: "" });
  };
  return {
    driver: {
      ...driver,
      succeeded: () => { created = true; driver.succeeded?.(); },
      repaint: () => { driver.repaint(); check(); },
    },
    outcome(started) {
      job = started;
      check();
      return settled;
    },
  };
}
