import { t } from "../../lib/i18n";
import { dismissWorktreeJob, retryWorktreeJob, worktreeJobs, type WorktreeJob } from "../../lib/worktree-jobs";
import { Button } from "../../shared/ui/primitives/button";

function WorktreeJobCard({ job }: { job: WorktreeJob }) {
  const failed = job.status === "failed";
  const title = job.input.label || job.input.branch || job.input.path || t("op.creatingWorktree");
  const context = [job.input.branch, job.input.path].filter(value => value && value !== title).join(" · ");
  return <article className={`card worktree-job worktree-job-${job.status}`}>
    <div className="worktree-job-body">
      <div className="card-title"><span className="card-name">{title}</span>
        {!failed && <span className="spinner worktree-job-spinner" />}
      </div>
      {context && <p className="card-meta">{context}</p>}
      <p className={failed ? "card-meta worktree-job-error" : "card-meta"}>{failed ? job.error : t("op.creatingWorktree")}</p>
    </div>
    <div className="worktree-job-actions">
      {failed && <Button className="btn btn-small" onClick={() => retryWorktreeJob(job.id)}>{t("retry")}</Button>}
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
