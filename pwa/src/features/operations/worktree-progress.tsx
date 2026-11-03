import { t } from "../../lib/i18n";
import { dismissWorktreeJob, retryWorktreeJob, worktreeJobs, type WorktreeJob } from "../../lib/worktree-jobs";
import { Button, Spinner } from "../../shared/ui/primitives";

function WorktreeJobCard({ job }: { job: WorktreeJob }) {
  const failed = job.status === "failed";
  // Jobs are page-wide; a card is retryable only where its session and target
  // are still live. Re-read on each paint, so switching back restores Retry.
  const owned = job.owns();
  const title = job.input.label || job.input.branch || job.input.path || t("op.creatingWorktree");
  const context = [job.input.branch, job.input.path].filter(value => value && value !== title).join(" · ");
  const retry = () => { retryWorktreeJob(job.id); };
  return <article className={`card worktree-job worktree-job-${job.status}`}>
    <div className="worktree-job-body">
      <div className="card-title"><span className="card-name">{title}</span>
        {!failed && <Spinner className="worktree-job-spinner" />}
      </div>
      {context && <p className="card-meta">{context}</p>}
      <p className={failed ? "card-meta worktree-job-error" : "card-meta"}>{failed ? job.error : t("op.creatingWorktree")}</p>
      {failed && !owned && <p className="card-meta">{t("err.worktreeSessionChanged")}</p>}
    </div>
    <div className="worktree-job-actions">
      {failed && owned && <Button className="btn btn-small" onClick={retry}>{t("retry")}</Button>}
      <Button className="btn btn-small btn-ghost" onClick={() => dismissWorktreeJob(job.id)}>{t(failed ? "dismiss" : "cancel")}</Button>
    </div>
  </article>;
}

export function WorktreeProgressList() {
  const jobs = worktreeJobs();
  return jobs.length ? <div className="worktree-jobs" aria-live="polite">
    {jobs.map(job => <WorktreeJobCard key={job.id} job={job} />)}
  </div> : null;
}
