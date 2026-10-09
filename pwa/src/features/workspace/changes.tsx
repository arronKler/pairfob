import { PenLine } from "lucide-react";
import { diffNoteCounts } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { Button, Chevron } from "../../shared/ui/primitives";
import { liveSession } from "../computers/catalog-store";
import { loadGitDiff, showMoreWorkspaceChanges, toggleWorkspaceChangeGroup } from "./actions";
import { changeKindLabel, layerLabel } from "./format";
import { FileIcon } from "./file-icon";
import { GitMark } from "./git-mark";
import { changeSections, type ChangeSection, type ChangeStep } from "./git-marks";
import type { WorkspaceSnapshot } from "./model";

function ChangeRow({ step, snapshot, notes }: { step: ChangeStep; snapshot: WorkspaceSnapshot; notes: number }) {
  const { path, layer, kind, change } = step;
  const active = snapshot.view === "diff" && snapshot.detailPath === path && snapshot.diffLayer === layer;
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return <Button
    className={`workspace-change status-${kind}${active ? " active" : ""}`}
    aria-label={`${path} · ${kind === "conflict" ? changeKindLabel(kind) : `${layerLabel(change, layer)} · ${changeKindLabel(kind)}`}${notes ? ` · ${t("workspace.noteCount", { count: notes })}` : ""}`}
    aria-current={active ? "true" : undefined}
    data-change={`${layer}:${path}`}
    data-trigger-of={`${layer}:${path}`}
    onClick={() => loadGitDiff(path, layer)}
  >
    <FileIcon kind="file" path={path} />
    <span className="workspace-change-head">
      <span className="workspace-row-name">{path.split("/").pop() || path}</span>
      <span className="workspace-row-meta">{directory || t("workspace.repoRoot")}</span>
      {change.original_path ? <span className="workspace-rename">{t("workspace.renamed", { path: change.original_path })}</span> : null}
    </span>
    {notes > 0 && <span className="workspace-change-notes" aria-hidden="true"><PenLine size={12} />{String(notes)}</span>}
    <GitMark kind={kind} />
    <Chevron />
  </Button>;
}

const GROUP_LABEL: Record<ChangeSection, "workspace.groupConflict" | "workspace.groupStaged" | "workspace.groupWorktree"> = {
  conflict: "workspace.groupConflict",
  staged: "workspace.groupStaged",
  worktree: "workspace.groupWorktree",
};

function ChangeGroup({ section, steps, snapshot, notes }: {
  section: ChangeSection; steps: ChangeStep[]; snapshot: WorkspaceSnapshot; notes: Map<string, number>;
}) {
  const label = t(GROUP_LABEL[section]);
  // Conflicts always stay open: they are what needs attention first.
  const expanded = section === "conflict" || snapshot.changeGroupsExpanded[section];
  const count = <span className="workspace-change-group-count">{String(steps.length)}</span>;
  return <section className={`workspace-change-group workspace-change-group-${section}`} aria-label={label}>
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
    {expanded && <div className="workspace-change-rows">
      {steps.map((step) => <ChangeRow key={`${step.layer}:${step.path}`} step={step} snapshot={snapshot}
        notes={notes.get(`${step.layer}:${step.path}`) ?? 0} />)}
    </div>}
  </section>;
}

export function ChangeList({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const status = snapshot.status;
  const changes = status?.changes ?? [];
  const sections = changeSections(changes.slice(0, snapshot.changeLimit));
  const notes = diffNoteCounts(liveSession(), snapshot.paneId);
  const reveal = snapshot.revealNav;
  return <section className={`workspace-panel workspace-changes${reveal ? " workspace-reveal" : ""}`}>
    <div className="workspace-change-groups">
      {(["conflict", "staged", "worktree"] as const).map((section) => sections[section].length > 0 &&
        <ChangeGroup key={section} section={section} steps={sections[section]} snapshot={snapshot} notes={notes} />)}
      {!snapshot.loading && !snapshot.error && !changes.length &&
        <p className="workspace-empty">{t("workspace.noChanges")}</p>}
      {status?.truncated && <p className="workspace-limit">{t("workspace.statusTruncated")}</p>}
    </div>
    {changes.length > snapshot.changeLimit && (
      <Button className="workspace-more" onClick={showMoreWorkspaceChanges}>
        {t("workspace.showMoreChanges", { count: changes.length - snapshot.changeLimit })}
      </Button>
    )}
  </section>;
}
