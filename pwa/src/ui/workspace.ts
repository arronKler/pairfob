import { button, node } from "../lib/dom";
import { highlightSource } from "../lib/syntax-highlight";
import {
  gitChangeKind,
  gitLayers,
  parseDiffLines,
  workspaceBreadcrumbs,
  type GitBranch,
  type GitChange,
  type GitChangeKind,
  type GitLayer,
} from "../lib/workspace";
import { locale, t } from "../lib/i18n";
import { createSelectedWorktree, listSelectedWorktrees, openSelectedWorktree } from "../live-operations";
import { app, state } from "../state";
import {
  closeWorkspaceDetail,
  ensureBranches,
  leaveWorkspace,
  loadDirectory,
  loadGitDiff,
  loadWorkspaceFile,
  refreshWorkspace,
  showWorkspaceTab,
  showMoreWorkspaceChanges,
  toggleWorkspaceChangeGroup,
  workspaceModel,
} from "../workspace";
import { appendNotice, backButton, chevron, spinnerNode } from "./chrome";
import { present, sheet, sheetItem, sheetSection } from "./sheet";

const MAX_RENDERED_DIFF_LINES = 800;
let modifiedDateLocale = "";
let modifiedDateFormatter: Intl.DateTimeFormat | null = null;

function workspaceBack(): void {
  if (workspaceModel.view === "browser") leaveWorkspace();
  else closeWorkspaceDetail();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function formatModified(value: number): string {
  const activeLocale = locale();
  if (!modifiedDateFormatter || modifiedDateLocale !== activeLocale) {
    modifiedDateLocale = activeLocale;
    modifiedDateFormatter = new Intl.DateTimeFormat(activeLocale, { month: "short", day: "numeric" });
  }
  return modifiedDateFormatter.format(new Date(value));
}

function branchLabel(): string {
  const git = workspaceModel.descriptor?.git;
  if (!git) return t("workspace.branch");
  return git.branch || `${t("workspace.detached")} · ${git.head.slice(0, 8)}`;
}

function header(): HTMLElement {
  const chrome = node("header", "workspace-chrome");
  chrome.append(backButton(workspaceBack, workspaceModel.view === "browser" ? t("workspace.back") : t("workspace.closeDetail")));
  const title = node("div", "workspace-title");
  title.append(
    node("strong", "workspace-name", workspaceModel.descriptor?.name || t("workspace.title")),
    node("span", "workspace-root", workspaceModel.descriptor?.root || ""),
  );
  const actions = node("div", "workspace-actions");
  if (workspaceModel.descriptor?.features.git_branches) {
    const branch = button(branchLabel(), "workspace-branch", openBranchSheet);
    branch.disabled = workspaceModel.loadingBranches;
    branch.setAttribute("aria-label", t("workspace.branches"));
    actions.append(branch);
  }
  const refresh = button("", "icon-btn workspace-refresh", refreshWorkspace);
  refresh.setAttribute("aria-label", t("workspace.refresh"));
  refresh.disabled = workspaceModel.loading;
  actions.append(refresh);
  if (workspaceModel.view !== "browser") {
    const dismiss = button("", "icon-btn workspace-dismiss", leaveWorkspace);
    dismiss.setAttribute("aria-label", t("workspace.dismiss"));
    dismiss.title = t("workspace.dismiss");
    actions.append(dismiss);
  }
  chrome.append(title, actions);
  return chrome;
}

function tabs(): HTMLElement {
  const tabs = node("div", "workspace-tabs");
  tabs.setAttribute("role", "tablist");
  const files = button(t("workspace.files"), `workspace-tab${workspaceModel.tab === "files" ? " on" : ""}`, () => showWorkspaceTab("files"));
  files.setAttribute("role", "tab");
  files.setAttribute("aria-selected", String(workspaceModel.tab === "files"));
  tabs.append(files);
  if (workspaceModel.descriptor?.features.git_status) {
    const count = workspaceModel.status?.changes.length ?? 0;
    const changes = button("", `workspace-tab${workspaceModel.tab === "changes" ? " on" : ""}`, () => showWorkspaceTab("changes"));
    changes.append(document.createTextNode(t("workspace.changes")));
    if (count) changes.append(node("span", "workspace-count", String(count)));
    changes.setAttribute("role", "tab");
    changes.setAttribute("aria-selected", String(workspaceModel.tab === "changes"));
    tabs.append(changes);
  }
  return tabs;
}

function breadcrumbs(): HTMLElement {
  const trail = node("nav", "workspace-breadcrumbs");
  trail.setAttribute("aria-label", t("workspace.files"));
  for (const [index, crumb] of workspaceBreadcrumbs(workspaceModel.directory).entries()) {
    if (index) trail.append(node("span", "workspace-crumb-sep", "/"));
    const label = crumb.path ? crumb.label : t("workspace.root");
    trail.append(button(label, "workspace-crumb", () => loadDirectory(crumb.path)));
  }
  return trail;
}

function fileList(): HTMLElement {
  const panel = node("section", "workspace-panel");
  panel.append(breadcrumbs());
  const list = node("div", "workspace-list");
  list.setAttribute("role", "list");
  for (const entry of workspaceModel.entries) {
    const row = button("", `workspace-row workspace-${entry.kind}${entry.hidden ? " is-hidden" : ""}`);
    row.setAttribute("role", "listitem");
    const icon = node("span", "workspace-entry-icon");
    icon.setAttribute("aria-hidden", "true");
    const body = node("span", "workspace-row-body");
    body.append(node("span", "workspace-row-name", entry.name));
    if (entry.kind === "file") body.append(node("span", "workspace-row-meta", `${formatBytes(entry.size)} · ${formatModified(entry.modified_ms)}`));
    row.append(icon, body, chevron());
    if (entry.kind === "directory") row.addEventListener("click", () => void loadDirectory(entry.path));
    else if (entry.kind === "file") row.addEventListener("click", () => void loadWorkspaceFile(entry.path));
    else row.disabled = true;
    list.append(row);
  }
  if (!workspaceModel.loading && !workspaceModel.entries.length) list.append(node("p", "workspace-empty", t("workspace.empty")));
  panel.append(list);
  if (workspaceModel.nextCursor) {
    const more = button(workspaceModel.loadingMore ? t("workspace.loading") : t("workspace.loadMore"), "workspace-more", () => loadDirectory(workspaceModel.directory, true));
    more.disabled = workspaceModel.loadingMore;
    panel.append(more);
  }
  if (workspaceModel.directoryTruncated) panel.append(node("p", "workspace-limit", t("workspace.directoryTruncated")));
  return panel;
}

function layerLabel(change: GitChange, layer: GitLayer): string {
  if (change.index === "?" && layer === "worktree") return t("workspace.untracked");
  return layer === "staged" ? t("workspace.staged") : t("workspace.worktree");
}

const CHANGE_CODES: Record<GitChangeKind, string> = {
  added: "A",
  conflict: "U",
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

function changeKindLabel(kind: GitChangeKind): string {
  return t(CHANGE_LABELS[kind]);
}

function changeRow(change: GitChange, layer: GitLayer): HTMLButtonElement {
  const kind = gitChangeKind(change, layer);
  const active = workspaceModel.view === "diff" && workspaceModel.detailPath === change.path && workspaceModel.diffLayer === layer;
  const item = button("", `workspace-change status-${kind}${active ? " active" : ""}`, () => loadGitDiff(change.path, layer));
  const heading = node("span", "workspace-change-head");
  const name = node("span", "workspace-row-name", change.path.split("/").pop() || change.path);
  const directory = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
  heading.append(name);
  if (directory) heading.append(node("span", "workspace-row-meta", directory));
  if (change.original_path) heading.append(node("span", "workspace-rename", t("workspace.renamed", { path: change.original_path })));
  const status = node("span", "workspace-change-mark", CHANGE_CODES[kind]);
  status.title = changeKindLabel(kind);
  status.setAttribute("aria-hidden", "true");
  item.setAttribute("aria-label", `${change.path} · ${layerLabel(change, layer)} · ${changeKindLabel(kind)}`);
  item.append(heading, status);
  return item;
}

function changeGroup(layer: GitLayer, changes: GitChange[]): HTMLElement {
  const group = node("section", `workspace-change-group workspace-change-group-${layer}`);
  const expanded = workspaceModel.changeGroupsExpanded[layer];
  const label = layer === "staged" ? t("workspace.groupStaged") : t("workspace.groupWorktree");
  const title = button("", "workspace-change-group-title", () => toggleWorkspaceChangeGroup(layer));
  title.setAttribute("aria-expanded", String(expanded));
  title.setAttribute("aria-label", label);
  const marker = node("span", "group-chev");
  marker.setAttribute("aria-hidden", "true");
  title.append(
    marker,
    node("span", "workspace-change-group-name", label),
    node("span", "workspace-change-group-count", String(changes.length)),
  );
  group.append(title);
  if (expanded) {
    const rows = node("div", "workspace-change-rows");
    for (const change of changes) {
      const row = changeRow(change, layer);
      rows.append(row);
    }
    group.append(rows);
  }
  return group;
}

function changeList(): HTMLElement {
  const panel = node("section", "workspace-panel workspace-changes");
  const status = workspaceModel.status;
  if (status) {
    const summary = node("div", "workspace-status-summary");
    summary.append(node("strong", "workspace-status-branch", status.branch || t("workspace.detached")));
    if (status.ahead) summary.append(node("span", "workspace-sync", t("workspace.ahead", { count: status.ahead })));
    if (status.behind) summary.append(node("span", "workspace-sync", t("workspace.behind", { count: status.behind })));
    panel.append(summary);
  }
  const changes = status?.changes ?? [];
  const visible = changes.slice(0, workspaceModel.changeLimit);
  const groups = node("div", "workspace-change-groups");
  const staged = visible.filter((change) => gitLayers(change).includes("staged"));
  const worktree = visible.filter((change) => gitLayers(change).includes("worktree"));
  if (staged.length) groups.append(changeGroup("staged", staged));
  if (worktree.length) groups.append(changeGroup("worktree", worktree));
  if (!workspaceModel.loading && !changes.length) groups.append(node("p", "workspace-empty", t("workspace.noChanges")));
  panel.append(groups);
  if (changes.length > workspaceModel.changeLimit) {
    panel.append(button(t("workspace.showMoreChanges", { count: changes.length - workspaceModel.changeLimit }), "workspace-more", showMoreWorkspaceChanges));
  }
  return panel;
}

function retryCurrent(): void {
  if (workspaceModel.view === "file" && workspaceModel.detailPath) void loadWorkspaceFile(workspaceModel.detailPath);
  else if (workspaceModel.view === "diff" && workspaceModel.detailPath) void loadGitDiff(workspaceModel.detailPath, workspaceModel.diffLayer);
  else void refreshWorkspace();
}

function feedback(): HTMLElement | null {
  if (workspaceModel.error) {
    const error = node("div", "workspace-feedback workspace-error");
    error.setAttribute("role", "alert");
    error.append(node("p", "", workspaceModel.error), button(t("ft.retry"), "btn btn-small", retryCurrent));
    return error;
  }
  if (workspaceModel.loading) {
    const loading = node("div", "workspace-feedback");
    loading.setAttribute("role", "status");
    loading.append(spinnerNode(), node("p", "", t("workspace.loading")));
    return loading;
  }
  return null;
}

function fileDetail(): HTMLElement {
  const detail = node("section", "workspace-detail-view");
  detail.setAttribute("aria-label", t("workspace.file"));
  const file = workspaceModel.file;
  const bar = node("div", "workspace-detail-head");
  bar.append(node("strong", "workspace-detail-name", file?.path || workspaceModel.detailPath));
  if (file) bar.append(node("span", "workspace-row-meta", `${formatBytes(file.size)} · ${formatModified(file.modified_ms)}`));
  detail.append(bar);
  const notice = feedback();
  if (notice) detail.append(notice);
  if (!file) return detail;
  if (file.kind === "binary") detail.append(node("p", "workspace-empty", t("workspace.binary")));
  else {
    const pre = node("pre", "workspace-code");
    const code = node("code", "workspace-highlight");
    for (const token of highlightSource(file.path, file.content)) {
      if (token.kind) code.append(node("span", `syntax-${token.kind}`, token.text));
      else code.append(document.createTextNode(token.text));
    }
    pre.append(code);
    detail.append(pre);
  }
  if (file.truncated) detail.append(node("p", "workspace-limit", t("workspace.previewTruncated")));
  return detail;
}

function diffDetail(): HTMLElement {
  const detail = node("section", "workspace-detail-view workspace-diff-view");
  detail.setAttribute("aria-label", t("workspace.diff"));
  const diff = workspaceModel.diff;
  const bar = node("div", "workspace-detail-head");
  bar.append(
    node("strong", "workspace-detail-name", diff?.path || workspaceModel.detailPath),
    node("span", "workspace-layer-label", workspaceModel.diffLayer === "staged" ? t("workspace.staged") : t("workspace.worktree")),
  );
  if (diff) {
    bar.append(
      node("span", "workspace-additions", t("workspace.additions", { count: diff.additions })),
      node("span", "workspace-deletions", t("workspace.deletions", { count: diff.deletions })),
    );
  }
  detail.append(bar);
  const notice = feedback();
  if (notice) detail.append(notice);
  if (!diff) return detail;
  const parsed = parseDiffLines(diff.patch);
  if (!parsed.length || (!diff.patch && !diff.binary)) detail.append(node("p", "workspace-empty", t("workspace.diffEmpty")));
  else if (diff.binary) detail.append(node("p", "workspace-empty", t("workspace.binary")));
  else {
    const table = node("div", "workspace-diff");
    table.setAttribute("role", "table");
    for (const line of parsed.slice(0, MAX_RENDERED_DIFF_LINES)) {
      const row = node("div", `workspace-diff-line diff-${line.kind}`);
      row.setAttribute("role", "row");
      row.append(
        node("span", "diff-line-number", line.oldLine === null ? "" : String(line.oldLine)),
        node("span", "diff-line-number", line.newLine === null ? "" : String(line.newLine)),
        node("code", "diff-line-text", line.text || " "),
      );
      table.append(row);
    }
    detail.append(table);
    if (parsed.length > MAX_RENDERED_DIFF_LINES) detail.append(node("p", "workspace-limit", t("workspace.diffRenderLimit", { count: MAX_RENDERED_DIFF_LINES })));
  }
  if (diff.truncated) detail.append(node("p", "workspace-limit", t("workspace.diffTruncated")));
  return detail;
}

function emptyDetail(): HTMLElement {
  const empty = node("section", "workspace-detail-empty");
  empty.append(node("strong", "", workspaceModel.descriptor?.name || t("workspace.title")), node("p", "", workspaceModel.descriptor?.root || ""));
  return empty;
}

function branchRows(branches: GitBranch[], kind: GitBranch["kind"]): HTMLElement[] {
  return branches.filter((branch) => branch.kind === kind).map((branch) => {
    const row = node("div", `workspace-branch-row${branch.current ? " current" : ""}`);
    const body = node("span", "workspace-branch-body");
    body.append(node("strong", "", branch.name));
    if (branch.upstream) body.append(node("span", "workspace-row-meta", branch.upstream));
    row.append(body);
    if (branch.current) row.append(node("span", "workspace-current", t("workspace.current")));
    return row;
  });
}

async function openBranchSheet(): Promise<void> {
  const branches = await ensureBranches();
  if (!branches) return;
  const parts = sheet(t("workspace.branches"));
  parts.body.append(node("p", "empty-sub", t("workspace.branchReadOnly")));
  const local = branchRows(branches.items, "local");
  const remote = branchRows(branches.items, "remote");
  if (local.length) parts.body.append(node("h3", "menu-section-title", t("workspace.localBranches")), ...local);
  if (remote.length) parts.body.append(node("h3", "menu-section-title", t("workspace.remoteBranches")), ...remote);
  if (!local.length && !remote.length) parts.body.append(node("p", "empty-sub", t("workspace.noBranches")));
  sheetSection(parts, t("workspace.worktreeActions"), [
    ...(state.operationCapabilities.list_worktrees ? [sheetItem(parts, t("menu.worktrees"), listSelectedWorktrees)] : []),
    ...(state.operationCapabilities.create_worktree ? [sheetItem(parts, t("menu.newWorktree"), createSelectedWorktree)] : []),
    ...(state.operationCapabilities.open_worktree ? [sheetItem(parts, t("menu.openWorktree"), openSelectedWorktree)] : []),
  ]);
  parts.body.append(sheetItem(parts, t("cancel"), parts.close));
  present(parts);
}

function renderWorkspaceRoot(): HTMLElement {
  const shell = node("div", `workspace-shell${workspaceModel.view === "browser" ? "" : " detail"}`);
  shell.append(header());
  const appNotice = node("div", "workspace-app-notice");
  appendNotice(appNotice);
  if (appNotice.children.length) shell.append(appNotice);
  const body = node("div", "workspace-body");
  const nav = node("aside", "workspace-nav");
  nav.append(tabs());
  const rootFeedback = workspaceModel.view === "browser" ? feedback() : null;
  if (rootFeedback) nav.append(rootFeedback);
  if (workspaceModel.tab === "files") nav.append(fileList());
  else nav.append(changeList());
  const main = node("main", "workspace-main");
  if (workspaceModel.view === "file") main.append(fileDetail());
  else if (workspaceModel.view === "diff") main.append(diffDetail());
  else main.append(emptyDetail());
  body.append(nav, main);
  shell.append(body);
  return shell;
}

export function renderWorkspace(): void {
  app.replaceChildren(renderWorkspaceRoot());
}
