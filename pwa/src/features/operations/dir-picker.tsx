import { ChevronLeft } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { filterDirs, type DirIndex, type DirIndexEntry, type DirIndexPort } from "../../lib/dir-index";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";

export type DirPickerWorkspace = { id: string; label: string; path?: string };

const EMPTY_LIMIT = 60;

function recentEntry(path: string): DirIndexEntry {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return {
    path,
    name: cut >= 0 ? path.slice(cut + 1) : path,
    parent: cut > 0 ? path.slice(0, cut) : path,
    repo: false,
  };
}

/**
 * The directory search page. The index comes from the computer once; typing
 * filters it here, because every keystroke through the relay is a round trip.
 * A directory picked here only fills the form: creating still checks the path.
 *
 * The field is the list's one focusable control and names the active row
 * through `aria-activedescendant`, as the command palette does, so a keyboard
 * reader moves through results without leaving the thing they type into.
 */
export function DirPicker({ port, current, workspaces, recents = [], onPick, onBack }: {
  port: DirIndexPort;
  current: string;
  workspaces: readonly DirPickerWorkspace[];
  recents?: readonly string[];
  onPick: (path: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<DirIndex | null>(() => port.cached());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const version = useRef(index?.version ?? "");
  const field = useRef<HTMLInputElement>(null);
  const listId = `dir-list-${useId().replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const optionId = (position: number) => `${listId}-${position}`;
  // This page exists to be typed into, so it takes focus itself; every other
  // field waits for the press that asks for the keyboard.
  useLayoutEffect(() => { field.current?.focus(); }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    port.fetch(version.current).then((next) => {
      if (!alive) return;
      if (next) {
        version.current = next.version;
        setIndex(next);
        port.save(next);
      }
      setLoading(false);
    }, () => {
      if (!alive) return;
      setLoading(false);
      setFailed(true);
    });
    return () => { alive = false; };
  }, [attempt, port]);

  const openPaths = useMemo(() => new Set(workspaces.flatMap((space) => space.path ? [space.path] : [])), [workspaces]);
  const empty = useMemo(() => {
    const entries = index?.entries ?? [];
    const paths = new Set(entries.map((entry) => entry.path));
    const top = entries.filter((entry) => !paths.has(entry.parent)).slice(0, EMPTY_LIMIT);
    const seen = new Set(top.map((entry) => entry.path));
    const recent: DirIndexEntry[] = [];
    for (const path of recents) {
      if (top.length + recent.length >= EMPTY_LIMIT) break;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      recent.push(recentEntry(path));
    }
    // The path already in the form comes first, so a search reopened on a deep
    // directory shows the choice instead of a page of its root's neighbours.
    if (current && !seen.has(current)) top.unshift(recentEntry(current));
    return { top, recent };
  }, [current, index, recents]);
  const needle = query.trim();
  const shown = needle ? filterDirs(index?.entries ?? [], query) : [...empty.top, ...empty.recent];
  const activeRow = Math.min(active, Math.max(0, shown.length - 1));

  // The active row stays in the scroller while the arrows walk past its edge.
  useEffect(() => {
    if (!shown.length) return;
    document.getElementById(optionId(activeRow))?.scrollIntoView({ block: "nearest" });
  }, [activeRow, shown.length, listId]);

  const row = (entry: DirIndexEntry, position: number) => (
    <Button key={entry.path} id={optionId(position)} role="option" aria-selected={position === activeRow}
      className={`menu-item create-dir create-dir-row${entry.path === current ? " is-selected" : ""}${position === activeRow ? " is-active" : ""}`}
      aria-current={entry.path === current ? "true" : undefined}
      onClick={() => onPick(entry.path)}>
      <span className="create-dir-text">
        <span className="create-dir-name">{entry.name}</span>
        <span className="create-dir-parent">{entry.parent}</span>
      </span>
      <span className="create-dir-tags">
        {entry.repo ? <span className="create-dir-tag">{t("create.dirRepoTag")}</span> : null}
        {openPaths.has(entry.path) ? <span className="create-dir-tag">{t("create.dirOpenTag")}</span> : null}
      </span>
    </Button>
  );

  return (
    <div className="create-sheet-body is-picking">
      <div className="create-picker-head">
        <Button className="icon-btn" aria-label={t("sheet.back")} onClick={onBack}>
          <ChevronLeft size={22} aria-hidden="true" />
        </Button>
        <h3 className="create-picker-title">{t("create.dirSearchTitle")}</h3>
      </div>
      <input ref={field} className="create-input" type="text" value={query} aria-label={t("create.dirSearchPlaceholder")}
        placeholder={t("create.dirSearchPlaceholder")} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={shown.length ? optionId(activeRow) : undefined}
        onChange={(event) => { setQuery(event.currentTarget.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive(shown.length ? Math.min(activeRow + 1, shown.length - 1) : 0);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(Math.max(activeRow - 1, 0));
          } else if (event.key === "Enter" && shown.length) {
            event.preventDefault();
            onPick(shown[activeRow].path);
          }
        }} />
      {failed ? (
        <p className="notice notice-error create-dir-notice" role="alert">
          {t("create.dirSearchFailed")}{" "}
          <Button className="text-link" onClick={() => setAttempt((count) => count + 1)}>{t("create.dirSearchRetry")}</Button>
        </p>
      ) : null}
      {index?.truncated ? <p className="create-hint">{t("create.dirSearchTruncated")}</p> : null}
      {!index && loading ? <p className="create-hint">{t("create.dirSearchLoading")}</p> : null}
      {needle && !shown.length ? <p className="create-hint">{t("create.dirSearchEmpty")}</p> : null}
      <div className="create-dir-options" role="listbox" id={listId} aria-label={t("create.dirSearchTitle")}>
        {needle ? shown.map((entry, position) => row(entry, position)) : <>
          {empty.top.length ? (
            <div role="group" aria-labelledby={`${listId}-top`}>
              <p id={`${listId}-top`} className="create-dir-group">{t("create.dirTop")}</p>
              {empty.top.map((entry, position) => row(entry, position))}
            </div>
          ) : null}
          {empty.recent.length ? (
            <div role="group" aria-labelledby={`${listId}-recent`}>
              <p id={`${listId}-recent`} className="create-dir-group">{t("create.dirRecent")}</p>
              {empty.recent.map((entry, position) => row(entry, empty.top.length + position))}
            </div>
          ) : null}
        </>}
      </div>
    </div>
  );
}
