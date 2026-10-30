import { ArrowUp, Folder, Search } from "lucide-react";
import { Fragment, useMemo } from "react";
import { t } from "../../lib/i18n";
import { workspaceBreadcrumbs } from "../../lib/workspace";
import { showActionSheet } from "../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuRow } from "../../shared/ui/overlay/menu-controls";
import { Button } from "../../shared/ui/primitives";
import { loadDirectory } from "./actions";
import { guardBackPress } from "./back-press";
import { useFileFilter } from "./file-filter";
import { FileRow } from "./file-row";
import { fileSearchOffered, searchable } from "./file-search";
import { RecentFiles, RepoResults, TurnFiles } from "./file-sections";
import { foldBreadcrumbs, gitMarks } from "./git-marks";
import type { WorkspaceSnapshot } from "./model";
import { useRecentFiles } from "./recent-files";
import { useListBeside } from "./list-beside";
import { ownFilesDialog } from "./surface-dialogs";
import { useTurnWrites } from "./turn-writes";
import { useKeyHint } from "./workspace-keys";

export function openPathSheet(snapshot: WorkspaceSnapshot, rootLabel: string): void {
  const crumbs = workspaceBreadcrumbs(snapshot.directory);
  ownFilesDialog(() => showActionSheet(t("workspace.jumpTo"), modal => <MenuGroup>
    {crumbs.map((crumb, depth) => {
      const current = crumb.path === snapshot.directory;
      const target = current ? { onClick: () => modal.dismiss() } : { modal, action: () => loadDirectory(crumb.path) };
      return <MenuRow key={crumb.path || "."} {...target}
        icon={<span className="workspace-jump-indent" style={{ paddingLeft: `${depth * 12}px` }}><Folder size={18} /></span>}
        label={crumb.path ? crumb.label : rootLabel}
        detail={current ? t("workspace.current") : undefined}
      />;
    })}
  </MenuGroup>, { className: "workspace-path-sheet", popover: "menu" }));
}

/** Beside the list, inside a folder, the trail stays: up · root / … / parent / current. One screen at a time the header carries it. */
function Breadcrumbs({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const rootLabel = snapshot.descriptor?.name || t("workspace.root");
  const crumbs = workspaceBreadcrumbs(snapshot.directory);
  const shown = foldBreadcrumbs(crumbs);
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
  const upKey = useKeyHint("parentFolder");
  return <nav className="workspace-breadcrumbs" aria-label={t("workspace.files")}>
    <Button className="workspace-up" aria-label={t("workspace.upDir")} title={upKey.title(t("workspace.upDir"))} aria-keyshortcuts={upKey.keys}
      disabled={parent === null} onClick={(event) => {
        if (parent === null) return;
        // Up stays under the pointer: a doubled press would climb two folders.
        guardBackPress(event);
        void loadDirectory(parent);
      }}>
      <ArrowUp size={18} aria-hidden="true" />
    </Button>
    <div className="workspace-crumbs">
      {shown.map((crumb, index) => {
        const last = index === shown.length - 1;
        return <Fragment key={`${crumb.path}:${index}`}>
          {index > 0 && <span className="workspace-crumb-sep" aria-hidden="true">/</span>}
          {"fold" in crumb
            ? <Button className="workspace-crumb workspace-crumb-fold" aria-label={t("workspace.foldedPath")} aria-haspopup="dialog"
              onClick={() => openPathSheet(snapshot, rootLabel)}><span className="workspace-crumb-label">…</span></Button>
            : <Button className={`workspace-crumb${last ? " is-current" : ""}`} aria-current={last ? "page" : undefined}
              onClick={(event) => {
                // A folder above: the trail is drawn again under the pointer, as with Up.
                if (!last) guardBackPress(event);
                void loadDirectory(crumb.path);
              }}><span className="workspace-crumb-label">{crumb.path ? crumb.label : rootLabel}</span></Button>}
        </Fragment>;
      })}
    </div>
  </nav>;
}

/**
 * Narrow the listing to the names that contain what is typed. It is the
 * directory's own filter: another directory starts empty, and it is kept while
 * the list is away for a file opened beside the session (`file-filter`). It
 * never takes focus by itself, so no keyboard rises over the list.
 */
function FilterField({ snapshot, query, onChange }: { snapshot: WorkspaceSnapshot; query: string; onChange: (next: string) => void }) {
  const folder = snapshot.directory ? snapshot.directory.split("/").pop() ?? "" : "";
  const label = folder ? t("workspace.filterIn", { name: folder }) : t("workspace.filter");
  return <label className="workspace-filter">
    <Search size={16} aria-hidden="true" />
    <input className="workspace-filter-input" type="search" value={query} placeholder={label} aria-label={label}
      autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search"
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); onChange(""); } }} />
  </label>;
}

export function matchesFilter(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || name.toLowerCase().includes(needle);
}

export function FileList({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const reveal = snapshot.revealNav;
  const marks = gitMarks(snapshot.status);
  const together = useListBeside();
  const [query, setQuery] = useFileFilter(`${snapshot.paneId}\n${snapshot.descriptor?.root ?? ""}\n${snapshot.directory}`);
  // Directories first, each group in the daemon's order. Filtering and sorting
  // the listing is redone only for a new listing or a new query, not for every
  // render of the panel around it.
  const entries = useMemo(() => [...snapshot.entries]
    .filter((entry) => matchesFilter(entry.name, query))
    .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory")), [snapshot.entries, query]);
  const filtering = query.trim() !== "";
  // The whole workspace is being asked as well: its section says what it found, or that it found nothing.
  const searching = filtering && searchable(query) && fileSearchOffered();
  // The filter narrows the pages that were loaded; a directory with more of them has names it has not seen.
  const partial = filtering && snapshot.nextCursor !== null;
  // Sections stand over the root's own rows: the rows get the repository's name as theirs.
  const root = snapshot.descriptor?.root ?? "";
  const turn = useTurnWrites(snapshot.paneId, snapshot.descriptor?.root).some((path) => marks.files.get(path) !== "deleted");
  const recents = useRecentFiles(root).entries.some((entry) => entry.path.includes("/"));
  const above = !filtering && !snapshot.directory && (turn || recents);
  return <section className={`workspace-panel${reveal ? " workspace-reveal" : ""}`}>
    {/* At the root there is nowhere to climb to, and the title above already names the repository. */}
    {together && snapshot.directory !== "" && <Breadcrumbs snapshot={snapshot} />}
    <FilterField snapshot={snapshot} query={query} onChange={setQuery} />
    <div className="workspace-list" role="list">
      {!filtering && !snapshot.directory && <TurnFiles snapshot={snapshot} marks={marks} />}
      {!filtering && !snapshot.directory && <RecentFiles snapshot={snapshot} marks={marks} />}
      {above && <h3 className="workspace-section is-static"><span className="workspace-section-name">{snapshot.descriptor?.name || t("workspace.root")}</span></h3>}
      {entries.map((entry) => <FileRow key={entry.path} entry={entry} snapshot={snapshot} marks={marks} />)}
      {filtering && <RepoResults snapshot={snapshot} marks={marks} query={query} listed={new Set(entries.map((entry) => entry.path))} />}
      {!snapshot.loading && !snapshot.error && !entries.length && !searching && !partial &&
        <p className="workspace-empty">{t(filtering ? "workspace.noMatch" : "workspace.empty")}</p>}
      {partial && <p className="workspace-search-note workspace-filter-partial" role="status">{t("workspace.filterPartial")}</p>}
    </div>
    {snapshot.nextCursor && (
      <Button className="workspace-more" disabled={snapshot.loadingMore} onClick={() => loadDirectory(snapshot.directory, true)}>
        {snapshot.loadingMore ? t("workspace.loading") : t("workspace.loadMore")}
      </Button>
    )}
    {snapshot.directoryTruncated && <p className="workspace-limit">{t("workspace.directoryTruncated")}</p>}
  </section>;
}
