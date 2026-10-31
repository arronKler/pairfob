import { PenLine } from "lucide-react";
import type { ReactNode } from "react";
import { diffNoteCounts } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { Button, Chevron, Fold } from "../../shared/ui/primitives";
import { useLiveSession } from "../computers/hooks";
import { loadGitDiff, showMoreWorkspaceChanges, toggleWorkspaceChangeGroup } from "./actions";
import { changeKindLabel, formatModifiedAge, layerLabel } from "./format";
import { FileIcon } from "./file-icon";
import { GitMark } from "./git-mark";
import { listedChanges, type ChangeRowItem, type ChangeSection, type ChangeStep } from "./git-marks";
import type { WorkspaceSnapshot } from "./model";
import { changeLineCount, isReviewed, reviewProgress, useReviewVersion } from "./review-progress";
import { useTurnWrites } from "./turn-writes";

/** How many cells the bar has, and how they divide between added and removed lines. */
const BAR_CELLS = 5;

export function barCells(additions: number, deletions: number): { added: number; removed: number; cells: number } {
  const total = additions + deletions;
  if (!total) return { added: 0, removed: 0, cells: 0 };
  const cells = Math.min(BAR_CELLS, total);
  // Either side that changed keeps at least one cell.
  let added = additions ? Math.max(1, Math.round((cells * additions) / total)) : 0;
  if (deletions && added === cells && cells > 1) added = cells - 1;
  return { added, removed: deletions ? cells - added : 0, cells: BAR_CELLS };
}

/**
 * `+3 −1` and a five-cell bar of the same proportion. The daemon counts lines
 * for every change when it can (git_change_stats); otherwise a row has its
 * size once its diff has been read. The bar is drawn where the row has room
 * for it (the style sheet decides).
 */
function ChangeStat({ root, step }: { root: string; step: ChangeStep }) {
  const count = changeLineCount(root, step);
  if (!count) return null;
  if (count.binary) return <span className="workspace-change-stat is-binary" aria-hidden="true">{t("workspace.binaryChange")}</span>;
  if (!count.additions && !count.deletions) return null;
  const bar = barCells(count.additions, count.deletions);
  return <span className="workspace-change-stat" aria-hidden="true">
    <span className="workspace-change-bar">
      {Array.from({ length: bar.cells }, (_, index) =>
        <i key={index} className={index < bar.added ? "is-added" : index < bar.added + bar.removed ? "is-removed" : ""} />)}
    </span>
    {count.additions > 0 && <span className="workspace-additions">{t("workspace.additions", { count: count.additions })}</span>}
    {count.deletions > 0 && <span className="workspace-deletions">{t("workspace.deletions", { count: count.deletions })}</span>}
  </span>;
}

/** A change this recent reads as the agent's ongoing work: its time is drawn warm. */
const RECENT_CHANGE_MS = 10 * 60_000;

/** A diff's size in words, for the row's name: the figures beside it are drawn for the eye only. */
function sizeSaid(root: string, step: ChangeStep): string {
  const count = changeLineCount(root, step);
  if (!count) return "";
  if (count.binary) return t("workspace.binaryChange");
  return [
    count.additions > 0 ? t("workspace.linesAdded", { count: count.additions }) : "",
    count.deletions > 0 ? t("workspace.linesRemoved", { count: count.deletions }) : "",
  ].filter(Boolean).join(", ");
}

/** What a diff's row and its layer tag both say of it: the path, its layer and kind, its size, whether it was seen, its notes. */
function changeSaid(root: string, step: ChangeStep, seen: boolean, written: boolean, notes: number): string {
  const { path, layer, kind, change } = step;
  return [
    path,
    kind === "conflict" ? changeKindLabel(kind) : `${layerLabel(change, layer)} · ${changeKindLabel(kind)}`,
    sizeSaid(root, step),
    t(seen ? "workspace.reviewed" : "workspace.unreviewed"),
    written ? t("workspace.turnMarkAria") : "",
    notes ? t("workspace.noteCount", { count: notes }) : "",
  ].filter(Boolean).join(" · ");
}

/**
 * The other layer of a file that is changed in both: its staged diff, as a tag
 * at the end of the file's one row. It is a diff of its own in every other
 * way: seen or not, with its own notes, a step of the stepper.
 */
function StagedTag({ step, snapshot, notes }: { step: ChangeStep; snapshot: WorkspaceSnapshot; notes: number }) {
  const { path, layer } = step;
  const root = snapshot.descriptor?.root ?? "";
  const seen = isReviewed(root, layer, path);
  const active = snapshot.view === "diff" && snapshot.detailPath === path && snapshot.diffLayer === layer;
  return <Button className={`workspace-change-layer${active ? " active" : ""}${seen ? " is-reviewed" : ""}`}
    aria-label={changeSaid(root, step, seen, false, notes)} aria-current={active ? "true" : undefined}
    data-change={`${layer}:${path}`} data-trigger-of={`${layer}:${path}`} onClick={() => loadGitDiff(path, layer)}>
    <span className="workspace-review-dot" aria-hidden="true" />
    <span>{t("workspace.staged")}</span>
    {notes > 0 && <span className="workspace-change-notes" aria-hidden="true"><PenLine size={12} />{String(notes)}</span>}
    {/* Its own size, where the row has the room for a second one (the style sheet decides). */}
    <ChangeStat root={root} step={step} />
  </Button>;
}

/**
 * A diff's row. `tag` is the file's other layer (`StagedTag`): it stands
 * before the row's size and mark, which stay in the list's own right-hand
 * column, and the row is pressed everywhere around it.
 */
function ChangeRow({ step, snapshot, notes, written, tag }: {
  step: ChangeStep; snapshot: WorkspaceSnapshot; notes: number; written: boolean; tag?: ReactNode;
}) {
  const { path, layer, kind, change } = step;
  const modified = change.modified_ms;
  const recent = modified !== undefined && Date.now() - modified < RECENT_CHANGE_MS;
  const root = snapshot.descriptor?.root ?? "";
  const active = snapshot.view === "diff" && snapshot.detailPath === path && snapshot.diffLayer === layer;
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const seen = isReviewed(root, layer, path);
  const said = changeSaid(root, step, seen, written, notes);
  const tail = <>
    {notes > 0 && <span className="workspace-change-notes" aria-hidden="true"><PenLine size={12} />{String(notes)}</span>}
    <ChangeStat root={root} step={step} />
    <GitMark kind={kind} />
  </>;
  const row = <Button
    className={`workspace-change status-${kind}${active ? " active" : ""}${seen ? " is-reviewed" : ""}`}
    aria-label={said}
    aria-current={active ? "true" : undefined}
    data-change={`${layer}:${path}`}
    data-trigger-of={`${layer}:${path}`}
    onClick={() => loadGitDiff(path, layer)}
  >
    {/* The session list's own status dot: filled once the diff has been read to its end. */}
    <span className="workspace-review-dot" aria-hidden="true" />
    <FileIcon kind="file" path={path} />
    <span className="workspace-change-head">
      <span className="workspace-row-name">{path.split("/").pop() || path}</span>
      <span className="workspace-row-meta">
        {directory || t("workspace.repoRoot")}
        {/* When it last changed on the computer; the agent's own turn outranks the clock. */}
        {written ? <span className="workspace-turn-mark">{t("workspace.turnMark")}</span>
          : modified !== undefined ? <span className={`workspace-change-age${recent ? " is-recent" : ""}`}>{formatModifiedAge(modified)}</span> : null}
      </span>
      {change.original_path ? <span className="workspace-rename">{t("workspace.renamed", { path: change.original_path })}</span> : null}
    </span>
    {!tag && tail}
  </Button>;
  if (!tag) return row;
  // The button's own area is stretched over the whole row (the style sheet), under the tag.
  return <div className={`workspace-change-pair${active ? " active" : ""}`}>
    {row}{tag}<span className="workspace-change-tail" aria-hidden="true">{tail}</span>
  </div>;
}

const GROUP_LABEL: Record<ChangeSection, "workspace.groupConflict" | "workspace.groupStaged" | "workspace.groupWorktree"> = {
  conflict: "workspace.groupConflict",
  staged: "workspace.groupStaged",
  worktree: "workspace.groupWorktree",
};

/**
 * The way on through a review that is under way: the first diff not yet seen.
 * It stands beside the first group's title; before anything is seen the first
 * row is that diff, and once everything is seen there is nowhere to go on to.
 */
function NextUnseen({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const progress = reviewProgress(snapshot);
  const next = progress.next;
  if (!next || !progress.seen) return null;
  return <Button className="workspace-next-unseen" onClick={() => loadGitDiff(next.path, next.layer)}>
    {t("workspace.nextUnreviewed")}<Chevron />
  </Button>;
}

function ChangeGroup({ section, rows, files, snapshot, notes, lead, written }: {
  section: ChangeSection; rows: ChangeRowItem[]; snapshot: WorkspaceSnapshot; notes: Map<string, number>; lead: boolean;
  written: ReadonlySet<string>;
  /**
   * The files of the whole group, drawn or not: what its title counts, like
   * the tab's badge. A row with a staged tag is one file with two diffs, and
   * the header's "seen" and the stepper count those, as its two dots show.
   */
  files: number;
}) {
  const label = t(GROUP_LABEL[section]);
  // Conflicts always stay open: they are what needs attention first.
  const expanded = section === "conflict" || snapshot.changeGroupsExpanded[section];
  const count = <span className="workspace-change-group-count">{String(files)}</span>;
  return <section className={`workspace-change-group workspace-change-group-${section}`} aria-label={label}>
    <div className="workspace-change-group-head">
      {section === "conflict"
        ? <h3 className="workspace-change-group-title is-static">
          <span className="workspace-change-group-name">{label}</span>{count}
          <span className="workspace-change-group-hint">{t("workspace.conflictHint")}</span>
        </h3>
        : <Button className="workspace-change-group-title" aria-expanded={expanded} aria-label={label}
          onClick={() => toggleWorkspaceChangeGroup(section)}>
          <Chevron className="group-chev" />
          <span className="workspace-change-group-name">{label}</span>{count}
        </Button>}
      {lead && <NextUnseen snapshot={snapshot} />}
    </div>
    <Fold open={expanded} lazy bodyClassName="workspace-change-rows">
      {rows.map(({ step, staged }) =>
        <ChangeRow key={`${step.layer}:${step.path}`} step={step} snapshot={snapshot}
          notes={notes.get(`${step.layer}:${step.path}`) ?? 0} written={written.has(step.path)}
          tag={staged && <StagedTag step={staged} snapshot={snapshot} notes={notes.get(`${staged.layer}:${staged.path}`) ?? 0} />} />)}
    </Fold>
  </section>;
}

export function ChangeList({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  // The rows follow what the reader has seen, and the sizes of the diffs they have read.
  useReviewVersion();
  const status = snapshot.status;
  const changes = status?.changes ?? [];
  // The rows and the stepper's order are one derivation (`listedChanges`); the limit only says how far down it is drawn.
  const listed = listedChanges(changes, snapshot.changeLimit);
  const notes = diffNoteCounts(useLiveSession(), snapshot.paneId);
  const reveal = snapshot.revealNav;
  const written = new Set(useTurnWrites(snapshot.paneId, snapshot.descriptor?.root));
  return <section className={`workspace-panel workspace-changes${reveal ? " workspace-reveal" : ""}`}>
    <div className="workspace-change-groups">
      {listed.groups.map((group, index) =>
        <ChangeGroup key={group.section} section={group.section} rows={group.rows} files={group.files} snapshot={snapshot} notes={notes} lead={index === 0}
          written={written} />)}
      {!snapshot.loading && !snapshot.error && !changes.length &&
        <p className="workspace-empty">{t("workspace.noChanges")}</p>}
      {status?.truncated && <p className="workspace-limit">{t("workspace.statusTruncated")}</p>}
    </div>
    {listed.hidden > 0 && (
      <Button className="workspace-more" onClick={showMoreWorkspaceChanges}>
        {t("workspace.showMoreChanges", { count: listed.hidden })}
      </Button>
    )}
  </section>;
}
