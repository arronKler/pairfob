import { List, PenLine } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { diffNoteCounts } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { showActionSheet, type ActionSheetController } from "../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuRow } from "../../shared/ui/overlay/menu-controls";
import { useMenuItemRole } from "../../shared/ui/overlay/popover-frame";
import { Button } from "../../shared/ui/primitives";
import { useLiveSession } from "../computers/hooks";
import { closeWorkspaceDetail, loadGitDiff, loadWorkspaceFile } from "./actions";
import { changeKindLabel, layerLabel } from "./format";
import { GitMark } from "./git-mark";
import { reviewOrder, type ChangeStep } from "./git-marks";
import { recentEntries } from "./recent-files";
import { isReviewed } from "./review-progress";
import { getWorkspaceSnapshot } from "./store";
import { ownFilesDialog } from "./surface-dialogs";

/**
 * The column's file switcher. Its one column has no room for the list beside
 * an open file, so the file's name opens the list as a menu instead: every
 * changed file with its mark, whether its diff was seen and how many notes
 * wait on it, in the order the stepper walks; under a file that is not a
 * change, the files the reader had open lately. A long list gets a filter.
 * The last row is the list itself.
 *
 * The filter is a field above the commands, not one of them: the surface's
 * menu is the list under it (`menuInside`). A mouse or the keyboard starts in
 * the field, where typing narrows the list at once, Down goes into the rows
 * and Enter opens the first match; a finger starts on the open file's row, so
 * no on-screen keyboard rises over a list the reader came to pick from.
 */

/** With more diffs than this (two for a file changed in both layers) the list is filtered by name rather than read through. */
export const SWITCHER_FILTER_MIN = 12;

const ROWS = ".workspace-switch-list .menu-row:not(:disabled)";

const nameOf = (path: string): string => path.split("/").pop() || path;
const folderOf = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : t("workspace.repoRoot");

function ChangeChoice({ step, root, notes, current, twoLayers, onPick }: {
  step: ChangeStep; root: string; notes: number; current: boolean; twoLayers: boolean; onPick: () => void;
}) {
  const role = useMenuItemRole();
  const seen = isReviewed(root, step.layer, step.path);
  const said = [
    step.path,
    step.kind === "conflict" ? changeKindLabel(step.kind) : `${layerLabel(step.change, step.layer)} · ${changeKindLabel(step.kind)}`,
    t(seen ? "workspace.reviewed" : "workspace.unreviewed"),
    notes ? t("workspace.noteCount", { count: notes }) : "",
  ].filter(Boolean).join(" · ");
  return <Button className={`menu-row workspace-switch-row${seen ? " is-reviewed" : ""}`} role={role} aria-label={said}
    aria-current={current ? "true" : undefined} data-autofocus={current ? "" : undefined} data-switch={`${step.layer}:${step.path}`}
    onClick={onPick}>
    <span className="workspace-review-dot" aria-hidden="true" />
    <span className="menu-row-label">
      <span className="workspace-switch-name">{nameOf(step.path)}</span>
      <small>{twoLayers ? `${folderOf(step.path)} · ${layerLabel(step.change, step.layer)}` : folderOf(step.path)}</small>
    </span>
    {notes > 0 && <span className="workspace-change-notes" aria-hidden="true"><PenLine size={12} />{String(notes)}</span>}
    <GitMark kind={step.kind} />
  </Button>;
}

function Switcher({ modal }: { modal: ActionSheetController }) {
  const snapshot = getWorkspaceSnapshot();
  const [query, setQuery] = useState("");
  const root = snapshot.descriptor?.root ?? "";
  const steps = reviewOrder(snapshot.status?.changes ?? []);
  const notes = diffNoteCounts(useLiveSession(), snapshot.paneId);
  const needle = query.trim().toLowerCase();
  const shown = needle ? steps.filter((step) => step.path.toLowerCase().includes(needle)) : steps;
  const layered = new Set(steps.filter((step, index) => steps.findIndex((other) => other.path === step.path) !== index).map((step) => step.path));
  // Under an open file the reader is among files, not changes: the ones they had open lately are a press away.
  const recent = snapshot.view === "file" ? recentEntries(root).filter((entry) => entry.path !== snapshot.detailPath) : [];
  const menu = useMenuItemRole() !== undefined;
  const pick = (step: ChangeStep) => modal.close(() => loadGitDiff(step.path, step.layer));
  const fromFilter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowDown") {
      const rows = [...(modal.form.current?.querySelectorAll<HTMLElement>(ROWS) ?? [])];
      const to = rows.find((row) => row.matches("[aria-current='true']")) ?? rows[0];
      if (!to) return;
      event.preventDefault();
      // The surface's own arrows start from the row that has focus: this one is theirs from here.
      event.stopPropagation();
      to.focus();
    } else if (event.key === "Enter" && needle && shown[0]) {
      event.preventDefault();
      pick(shown[0]);
    }
  };
  return <>
    {steps.length > SWITCHER_FILTER_MIN && <input className="workspace-switch-filter" type="search" enterKeyHint="search" autoComplete="off"
      autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder={t("workspace.switchFilter")} aria-label={t("workspace.switchFilter")}
      data-desk-autofocus="" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={fromFilter} />}
    {needle && !shown.length && <p className="workspace-switch-none" role="status">{t("workspace.noMatch")}</p>}
    <div className="workspace-switch-list" role={menu ? "menu" : undefined} aria-label={menu ? t("workspace.switchFile") : undefined}>
      {shown.length > 0 && <MenuGroup label={t("workspace.changes")}>
        {shown.map((step) => <ChangeChoice key={`${step.layer}:${step.path}`} step={step} root={root}
          notes={notes.get(`${step.layer}:${step.path}`) ?? 0} twoLayers={layered.has(step.path)}
          current={snapshot.view === "diff" && snapshot.detailPath === step.path && snapshot.diffLayer === step.layer}
          onPick={() => pick(step)} />)}
      </MenuGroup>}
      {!needle && recent.length > 0 && <p className="workspace-switch-head" aria-hidden="true">{t("workspace.recent")}</p>}
      {!needle && recent.length > 0 && <MenuGroup label={t("workspace.recent")}>
        {recent.map((entry) => <MenuRow key={entry.path} modal={modal} action={() => loadWorkspaceFile(entry.path)}
          label={nameOf(entry.path)} detail={folderOf(entry.path)} />)}
      </MenuGroup>}
      <MenuGroup>
        <MenuRow modal={modal} action={() => closeWorkspaceDetail()} icon={<List size={18} />} label={t("workspace.switchList")} />
      </MenuGroup>
    </div>
  </>;
}

/** Open the switcher at the file's name. */
export function openFileSwitcher(anchor: HTMLElement): void {
  const snapshot = getWorkspaceSnapshot();
  if (snapshot.view === "browser") return;
  ownFilesDialog(() => showActionSheet(t("workspace.switchFile"), (modal) => <Switcher modal={modal} />,
    { className: "workspace-file-menu workspace-switcher", popover: "menu", anchor, menuInside: true }));
}
