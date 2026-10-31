import { ChevronRight, Clock3, FileDiff, GitBranch, Search } from "lucide-react";
import type { ReactNode } from "react";
import { commandKOffered, useHardwareKeyboard } from "../../app/input-mode";
import { diffNoteCounts } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { openCommandPalette } from "../command-palette";
import { useLiveSession } from "../computers/hooks";
import { loadGitDiff, loadWorkspaceFile, showWorkspaceTab } from "./actions";
import { fileSearchOffered } from "./file-search";
import { branchParts } from "./header";
import type { WorkspaceSnapshot } from "./model";
import { useRecentFiles } from "./recent-files";
import { changeTotals, reviewProgress, useReviewVersion } from "./review-progress";

/**
 * The detail pane beside the list while nothing is open in it. It is laid out
 * as the desk's own empty main column is (`desk-empty`): a heading and its
 * line, the places worth going to as large entries, then one main action and
 * one way to search. Each entry is a control of the list or the header said
 * again where the reader is looking: the review to go on with, the file they
 * last had open, the repository's branches.
 */

function Entry({ icon, title, meta, onOpen, popup = false }: {
  icon: ReactNode; title: string; meta: ReactNode; onOpen?: () => void; popup?: boolean;
}) {
  const body = <>
    <span className="workspace-overview-icon" aria-hidden="true">{icon}</span>
    <span className="workspace-overview-copy">
      <span className="workspace-overview-name">{title}</span>
      <span className="workspace-overview-meta">{meta}</span>
    </span>
  </>;
  if (!onOpen) return <li><div className="workspace-overview-entry is-static">{body}</div></li>;
  return <li>
    <Button className="workspace-overview-entry" aria-haspopup={popup ? "dialog" : undefined} onClick={onOpen}>
      {body}<ChevronRight size={16} aria-hidden="true" />
    </Button>
  </li>;
}

export function WorkspaceOverview({ snapshot, onBranches }: { snapshot: WorkspaceSnapshot; onBranches: () => void }) {
  useReviewVersion();
  // The key hints follow the keyboard: a tablet gains them with its first physical key.
  const keyboard = useHardwareKeyboard();
  const descriptor = snapshot.descriptor;
  const root = descriptor?.root ?? "";
  const recent = useRecentFiles(root).entries;
  const reviews = Boolean(descriptor?.features.git_status && snapshot.status);
  const progress = reviewProgress(snapshot);
  const totals = changeTotals(snapshot);
  let waiting = 0;
  for (const count of diffNoteCounts(useLiveSession(), snapshot.paneId).values()) waiting += count;
  const branch = branchParts(snapshot);
  const next = progress.next;
  const search = fileSearchOffered();

  return <section className="workspace-overview" aria-label={descriptor?.name || t("workspace.title")}>
    <h2 className="workspace-overview-title">{descriptor?.name || t("workspace.title")}</h2>
    <p className="workspace-overview-root">{root}</p>
    <ul className="workspace-overview-list">
      {reviews && (progress.total
        ? <Entry icon={<FileDiff size={18} />} title={t(next ? "workspace.overviewReview" : "workspace.overviewReviewed")}
          onOpen={() => next ? void loadGitDiff(next.path, next.layer) : showWorkspaceTab("changes")}
          meta={<>
            {totals && totals.additions > 0 && <span className="workspace-additions">{t("workspace.additions", { count: totals.additions })}</span>}
            {totals && totals.deletions > 0 && <span className="workspace-deletions">{t("workspace.deletions", { count: totals.deletions })}</span>}
            <span>{t("workspace.reviewedCount", { seen: progress.seen, total: progress.total })}</span>
            {waiting > 0 && <span className="workspace-overview-notes">{t("diffNotes.pending", { count: waiting })}</span>}
          </>} />
        : <Entry icon={<FileDiff size={18} />} title={t("workspace.overviewClean")} meta={t("workspace.noChanges")} />)}
      {recent.length > 0 && <Entry icon={<Clock3 size={18} />} title={t("workspace.recent")}
        onOpen={() => void loadWorkspaceFile(recent[0].path)}
        meta={<><span className="workspace-overview-path">{recent[0].path}</span>
          {recent.length > 1 && <span>{t("workspace.overviewMore", { count: recent.length - 1 })}</span>}</>} />}
      {branch && <Entry icon={<GitBranch size={18} />} title={t("workspace.overviewBranches")} popup
        onOpen={descriptor?.features.git_branches ? onBranches : undefined}
        meta={<><span className="workspace-overview-path">{branch.branch}</span>{branch.sync && <span>{branch.sync}</span>}</>} />}
    </ul>
    {(next || search) && <div className="workspace-overview-actions">
      {next && <Button className="btn btn-small btn-primary" onClick={() => void loadGitDiff(next.path, next.layer)}>
        {t(progress.seen ? "workspace.overviewContinue" : "workspace.overviewStart")}
      </Button>}
      {search && <Button className="btn btn-small workspace-overview-search" aria-haspopup="dialog" onClick={openCommandPalette}>
        <Search size={16} aria-hidden="true" />{t("workspace.overviewSearch")}
        {commandKOffered() ? <kbd aria-hidden="true">⌘K</kbd> : null}
      </Button>}
    </div>}
    {keyboard && <p className="workspace-overview-keys" aria-hidden="true">
      <span><kbd>Tab</kbd>{t("palette.hintMove")}</span>
      <span><kbd>↵</kbd>{t("palette.hintOpen")}</span>
      <span><kbd>esc</kbd>{t("workspace.overviewBack")}</span>
    </p>}
  </section>;
}
