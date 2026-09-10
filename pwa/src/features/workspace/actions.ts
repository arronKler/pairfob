import { liveSession } from "../computers/catalog-store";
import { isAgentChat, isFullTerminal, openPaneId } from "../session/session-store";
import { adoptDiffNoteScope } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import type { GitBranches, GitDiff, GitLayer, WorkspaceDirectoryPage } from "../../lib/workspace";
import { messageOf } from "../../lib/notices";
import { type WorkspaceReturnView, type WorkspaceTab } from "./model";
import { clearWorkspaceMedia, loadWorkspaceMedia, prepareWorkspaceMedia } from "./media-actions";
import { classifyWorkspaceFile } from "./media-model";
import { applyWorkspaceNavigation, leaveWorkspaceToHome, prepareWorkspaceEnter, restoreWorkspaceLeave } from "./navigation";
import { cloneData } from "./immutable";
import {
  activeScope,
  applyBrowserTab,
  armPendingReveal,
  beginEnter,
  beginLeave,
  bindScope,
  bumpWorkspaceChangeLimit,
  clearWorkspaceError,
  getWorkspaceSnapshot,
  issueTicket,
  markWorkspaceBrowser,
  noteDirectoryPage,
  readCache,
  currentMediaGeneration,
  toggleChangeGroup,
  type WorkspaceTicket,
} from "./store";

function workspaceError(error: unknown): string {
  if (error instanceof ProtocolError && error.code === "unknown_op") return t("workspace.unsupported");
  return messageOf(error);
}

function bindDiffNotes(session: object, paneId: string, diff: GitDiff | null): void {
  adoptDiffNoteScope(diff?.revision ? { session, paneId, revision: diff.revision } : null);
}

export async function enterWorkspace(
  paneId = openPaneId(),
  returnView: WorkspaceReturnView = isFullTerminal() ? "full" : isAgentChat() ? "agent" : "guided",
  force = false,
): Promise<void> {
  const session = liveSession();
  if (!session || !paneId) return;
  prepareWorkspaceEnter();
  const { ticket, cached } = beginEnter(session, paneId, returnView);
  applyWorkspaceNavigation({ screen: "workspace" });
  try {
    const scope = await readCache(session).open(paneId, force);
    if (!bindScope(ticket, scope)) return;
    ticket.commit({ descriptor: scope.descriptor });
    let pages = 1;
    if (cached?.root === scope.descriptor.root) {
      ticket.commit({ ...cached.navigation });
      if (!force) pages = cached.directoryPageCount;
    }
    const restored = getWorkspaceSnapshot();
    const detail = restored.view !== "browser";
    const tasks: Promise<void>[] = [];
    if (restored.view === "file") tasks.push(loadWorkspaceFile(restored.detailPath));
    else if (restored.view === "diff") tasks.push(loadGitDiff(restored.detailPath, restored.diffLayer));
    tasks.push(restoreDirectory(restored.directory, pages, ticket, detail));
    if (scope.descriptor.features.git_status) tasks.push(loadStatus(ticket));
    await Promise.all(tasks);
  } catch (error) {
    ticket.commit({ error: workspaceError(error) });
  } finally {
    if (ticket.current() && ticket.sameContent()) ticket.finishLoad();
  }
}

async function restoreDirectory(path: string, pages: number, owner: WorkspaceTicket, preserveDetail: boolean): Promise<void> {
  for (let page = 0; page < pages; page++) {
    const more = await loadDirectoryPage(path, page > 0, preserveDetail, owner);
    if (!more) return;
  }
}

export function leaveWorkspace(): void {
  const { paneId, returnView } = beginLeave();
  const session = liveSession();
  adoptDiffNoteScope(null);
  if (!paneId || !session || liveSession() !== session) {
    leaveWorkspaceToHome();
    return;
  }
  restoreWorkspaceLeave(paneId, returnView);
}

export async function loadDirectory(path: string, append = false): Promise<void> {
  await loadDirectoryPage(path, append, false);
}

async function loadDirectoryPage(
  path: string,
  append: boolean,
  preserveDetail: boolean,
  owner?: WorkspaceTicket,
): Promise<boolean> {
  const session = liveSession();
  const snap = getWorkspaceSnapshot();
  const scope = activeScope();
  if (!session || !snap.paneId || !scope) return false;
  if (owner && !owner.current()) return false;
  const cursor = append ? snap.nextCursor ?? "" : "";
  if (append && !cursor) return false;
  const ticket = issueTicket({
    content: preserveDetail ? "keep" : "bump",
    directory: "bump",
  });
  if (!ticket) return false;
  const previousDirectory = snap.directory;
  const previousEntries = snap.entries;
  const jumped = !append && path !== snap.directory;
  ticket.commit({
    error: "",
    loadingMore: append,
    ...(!append && !preserveDetail ? { loading: true } : {}),
    ...(jumped ? { directory: path, entries: [], nextCursor: null } : {}),
  });
  if (ticket.current() && (jumped || (!append && !snap.entries.length))) armPendingReveal();
  const apply = (page: WorkspaceDirectoryPage) => ticket.commit({
    directory: page.path,
    entries: append ? [...previousEntries, ...page.entries] : page.entries,
    nextCursor: page.next_cursor,
    directoryTruncated: page.truncated,
    ...(!append && !preserveDetail
      ? { file: null, diff: null, detailPath: "", view: "browser" as const }
      : {}),
  }, !append && !preserveDetail ? () => adoptDiffNoteScope(null) : undefined);
  const read = scope.directory(path, cursor);
  if (read.cached) apply(read.cached);
  try {
    const page = await read.value;
    if (!ticket.current()) return false;
    if (apply(page) && ticket.current()) noteDirectoryPage(append);
  } catch (error) {
    ticket.commit({
      error: workspaceError(error),
      ...(jumped ? { directory: previousDirectory } : {}),
    });
  } finally {
    if (ticket.current()) {
      if (!preserveDetail) ticket.finishLoad();
      else ticket.commit({ loadingMore: false });
    }
  }
  const now = getWorkspaceSnapshot();
  return ticket.current() && ticket.sameContent() && now.directory === path && Boolean(now.nextCursor) && !now.error;
}

export async function loadWorkspaceFile(path: string): Promise<void> {
  const snap = getWorkspaceSnapshot();
  const scope = activeScope();
  const ticket = issueTicket({ content: "bump" });
  if (!ticket || !scope) return;
  const keep = snap.file?.path === path;
  // Switching detail content retires any prior media load/resource BEFORE the
  // notifying commit, so a media load a subscriber starts in reaction to this
  // commit is the newer generation and is not cancelled afterward.
  clearWorkspaceMedia();
  ticket.commit({
    loading: true,
    error: "",
    view: "file",
    detailPath: path,
    ...(keep ? {} : { file: null }),
  }, () => adoptDiffNoteScope(null));
  if (!keep && ticket.current()) armPendingReveal();
  const read = scope.file(path);
  if (read.cached) ticket.commit({ file: read.cached });
  try {
    const file = await read.value;
    // This await (and every publication) can reenter: a newer pane/root/content
    // switch retires this ticket. Publish the text, then only drive the owned
    // media surface for THIS read if the commit actually landed on its own owner —
    // a stale binary read must not prepare/autoload media under the new scope
    // (prepare/load issue their own tickets, so calling them after a retired read
    // would attach the old file to the current owner).
    if (!ticket.current()) return;
    if (!ticket.commit({ file })) return;
    if (!ticket.current() || !ticket.sameContent()) return;
    // A binary file, or a TEXT file that is an SVG, drives the owned media
    // surface: images auto-load, while AV and SVG wait for an explicit view
    // action (SVG shows its source plus a full-download entry via the media
    // loader, never an injected inline element). Ordinary text files skip media.
    const mediaRole = classifyWorkspaceFile(file.path);
    const needsMedia = file.kind === "binary" || (file.kind === "text" && mediaRole === "svg");
    if (needsMedia) {
      // prepare is synchronous and claims exactly one fresh media generation, so
      // the generation it produced is currentMediaGeneration() captured here. It
      // then publishes, which can reenter (beginEnter on a new pane, a newer media
      // request, retirement). Only auto-load an image when NO newer owner claimed a
      // generation during that publication, and carry that precise generation so a
      // stale autoload can never take a fresh ticket for a replaced owner.
      // Directory navigation can retire the file ticket without changing media
      // generation. Both owners must still match after preparation publishes.
      // AV/SVG/download wait for an explicit view action instead.
      const generationBefore = currentMediaGeneration();
      const role = prepareWorkspaceMedia(file.path, file.size);
      const preparedGeneration = generationBefore + 1;
      if (
        role === "image" && currentMediaGeneration() === preparedGeneration
        && ticket.current() && ticket.sameContent()
      ) {
        void loadWorkspaceMedia(file.path, preparedGeneration);
      }
    }
  } catch (error) {
    ticket.commit({ error: workspaceError(error) });
  } finally {
    ticket.finishLoad();
  }
}

export async function loadStatus(owner?: WorkspaceTicket): Promise<void> {
  const snap = getWorkspaceSnapshot();
  const scope = activeScope();
  if (!scope || snap.descriptor?.features.git_status === false) return;
  if (owner && !owner.current()) return;
  const ticket = issueTicket({ status: "bump" });
  if (!ticket || (owner && !owner.current())) return;
  const read = scope.status();
  if (read.cached) ticket.commit({ status: read.cached });
  try {
    const status = await read.value;
    ticket.commit({ status });
  } catch (error) {
    ticket.commit({ error: workspaceError(error) });
  }
}

export async function refreshWorkspace(): Promise<void> {
  const snap = getWorkspaceSnapshot();
  await enterWorkspace(snap.paneId, snap.returnView, true);
}

export async function loadGitDiff(path: string, layer: GitLayer): Promise<void> {
  const snap = getWorkspaceSnapshot();
  const scope = activeScope();
  const session = liveSession();
  const ticket = issueTicket({ content: "bump" });
  if (!ticket || !scope || !session) return;
  const paneId = snap.paneId;
  const keep = Boolean(snap.diff && snap.diff.path === path && snap.diffLayer === layer);
  // A diff navigation is a content switch: retire any held media operation/URL
  // before the diff commit (content version is bumped by this ticket).
  clearWorkspaceMedia();
  ticket.commit({
    loading: true,
    error: "",
    view: "diff",
    detailPath: path,
    diffLayer: layer,
    ...(keep ? {} : { diff: null }),
  }, keep ? undefined : () => adoptDiffNoteScope(null));
  if (!keep && ticket.current()) armPendingReveal();
  const read = scope.diff(path, layer);
  const cachedDiff = read.cached;
  if (cachedDiff) {
    ticket.commit({ diff: cachedDiff }, () => bindDiffNotes(session, paneId, cachedDiff));
  }
  try {
    const diff = await read.value;
    ticket.commit({ diff }, () => bindDiffNotes(session, paneId, diff));
  } catch (error) {
    ticket.commit({ error: workspaceError(error) });
  } finally {
    ticket.finishLoad();
  }
}

export function showWorkspaceTab(tab: WorkspaceTab): void {
  const ticket = issueTicket({ content: "bump" });
  if (!ticket) {
    applyBrowserTab(tab);
    return;
  }
  // Retire the current media resource BEFORE the notifying tab publication so the
  // view leaves the detail clean (URL revoked, loader empty). A fresh media load a
  // subscriber starts IN reaction to the tab publication claims a NEWER generation
  // and is therefore not cancelled by this pre-notify retirement.
  clearWorkspaceMedia();
  ticket.commit({ tab, view: "browser", error: "" });
  ticket.finishLoad();
  if (tab === "changes" && ticket.current()) void loadStatus();
}

export function closeWorkspaceDetail(): void {
  const ticket = issueTicket({ content: "bump" });
  clearWorkspaceMedia();
  // Close the detail view but keep the selected path (detailPath): the list
  // highlights the still-selected row (FileRow derives active from it), and
  // a scope/enter/root change retires that selection naturally. Clearing the
  // path here would drop the row highlight on close.
  ticket?.commit({ view: "browser", file: null, diff: null, error: "" });
  ticket?.finishLoad();
}

export function showMoreWorkspaceChanges(): void {
  bumpWorkspaceChangeLimit();
}

export function toggleWorkspaceChangeGroup(layer: GitLayer): void {
  toggleChangeGroup(layer);
}

export { clearWorkspaceError, markWorkspaceBrowser };

export async function ensureBranches(): Promise<GitBranches | null> {
  const scope = activeScope();
  const ticket = issueTicket({ branches: "bump" });
  if (!ticket || !scope) return null;
  ticket.commit({ loadingBranches: true });
  const read = scope.branches();
  if (read.cached) ticket.commit({ branches: read.cached });
  try {
    const branches = await read.value;
    if (!ticket.commit({ branches }) || !ticket.current()) return null;
    const published = getWorkspaceSnapshot().branches;
    return published ? cloneData(published) as GitBranches : null;
  } catch (error) {
    ticket.commit({ error: messageOf(error) });
    return null;
  } finally {
    ticket.commit({ loadingBranches: false });
  }
}
