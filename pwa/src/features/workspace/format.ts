import { locale, t } from "../../lib/i18n";
import type { GitChange, GitChangeKind, GitLayer, WorkspaceRepository } from "../../lib/workspace";
import type { WorkspaceReturnView } from "./model";

let modifiedDateLocale = "";
let modifiedDateFormatter: Intl.DateTimeFormat | null = null;

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatModified(value: number): string {
  const activeLocale = locale();
  if (!modifiedDateFormatter || modifiedDateLocale !== activeLocale) {
    modifiedDateLocale = activeLocale;
    modifiedDateFormatter = new Intl.DateTimeFormat(activeLocale, { month: "short", day: "numeric" });
  }
  return modifiedDateFormatter.format(new Date(value));
}

/**
 * Where leaving the workspace screen lands. The screen returns to the view it
 * was opened from, so its ways out name that view: the conversation, or the
 * terminal (guided control and the complete terminal alike). The view is fixed
 * when the screen opens; nothing changes it underneath.
 */
export function backLabel(returnView: WorkspaceReturnView): string {
  return t(returnView === "agent" ? "workspace.backChat" : "workspace.back");
}

/** The same destination as a visible action: the receipt's chip, the menu row's detail. */
export function returnLabel(returnView: WorkspaceReturnView): string {
  return t(returnView === "agent" ? "workspace.backToChat" : "workspace.backToTerminal");
}

export function branchLabel(git: WorkspaceRepository | null | undefined): string {
  if (!git) return t("workspace.branch");
  return git.branch || `${t("workspace.detached")} · ${git.head.slice(0, 8)}`;
}

export function layerLabel(change: GitChange, layer: GitLayer): string {
  if (change.index === "?" && layer === "worktree") return t("workspace.untracked");
  return layer === "staged" ? t("workspace.staged") : t("workspace.worktree");
}

export const CHANGE_CODES: Record<GitChangeKind, string> = {
  added: "A",
  conflict: "!",
  copied: "C",
  deleted: "D",
  modified: "M",
  renamed: "R",
  type: "T",
  untracked: "U",
};

const CHANGE_LABELS = {
  added: "workspace.status.added",
  conflict: "workspace.status.conflict",
  copied: "workspace.status.copied",
  deleted: "workspace.status.deleted",
  modified: "workspace.status.modified",
  renamed: "workspace.status.renamed",
  type: "workspace.status.type",
  untracked: "workspace.status.untracked",
} as const;

export function changeKindLabel(kind: GitChangeKind): string {
  return t(CHANGE_LABELS[kind]);
}
