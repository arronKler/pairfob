/* Progress cards for in-flight CreateWorktree jobs, rendered above the
 * session list on home and in the wide rail. Working cards can be cancelled
 * locally; failed cards offer Retry (fresh operation_id) and Dismiss. */

import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { dismissWorktreeJob, retryWorktreeJob, worktreeJobs, type WorktreeJob } from "../lib/worktree-jobs";

export function worktreeProgressList(): HTMLElement | null {
  const jobs = worktreeJobs();
  if (!jobs.length) return null;
  const list = node("div", "worktree-jobs");
  list.setAttribute("aria-live", "polite");
  for (const job of jobs) list.append(worktreeJobCard(job));
  return list;
}

function jobTitle(job: WorktreeJob): string {
  return job.input.label || job.input.branch || job.input.path || t("op.creatingWorktree");
}

function jobContext(job: WorktreeJob): string {
  const title = jobTitle(job);
  return [job.input.branch, job.input.path].filter((value) => value && value !== title).join(" · ");
}

function worktreeJobCard(job: WorktreeJob): HTMLElement {
  const failed = job.status === "failed";
  const card = node("article", `card worktree-job worktree-job-${job.status}`);
  const body = node("div", "worktree-job-body");
  const titleRow = node("div", "card-title");
  titleRow.append(node("span", "card-name", jobTitle(job)));
  if (!failed) titleRow.append(node("span", "spinner worktree-job-spinner"));
  body.append(titleRow);
  const context = jobContext(job);
  if (context) body.append(node("p", "card-meta", context));
  body.append(node("p", failed ? "card-meta worktree-job-error" : "card-meta", failed ? job.error : t("op.creatingWorktree")));
  card.append(body);
  const actions = node("div", "worktree-job-actions");
  if (failed) {
    actions.append(button(t("retry"), "btn btn-small", () => retryWorktreeJob(job.id)));
    actions.append(button(t("dismiss"), "btn btn-small btn-ghost", () => dismissWorktreeJob(job.id)));
  } else {
    actions.append(button(t("cancel"), "btn btn-small btn-ghost", () => dismissWorktreeJob(job.id)));
  }
  card.append(actions);
  return card;
}
