import { File, LayoutDashboard, Monitor, Plus, Search, Settings, X, type LucideIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../lib/i18n";
import { dialogClass } from "../../shared/ui/overlay/desk-form";
import { useDialogLifecycle } from "../../shared/ui/overlay/dialog-lifecycle";
import type { ModalController } from "../../shared/ui/overlay/modal";
import { AgentAvatar } from "../../shared/ui/primitives";
import { activeItem, buildPalette, paletteFile, stepActive, type PaletteActionId, type PaletteFile, type PaletteItem, type PaletteSession } from "./model/palette";
import type { CommandPalettePorts } from "./ports";

/** What the palette settles with: the jump to make once it has closed. */
export type PaletteRun = () => void;

const ACTION_ICONS: Record<PaletteActionId, LucideIcon> = {
  create: Plus,
  desktop: Monitor,
  board: LayoutDashboard,
  computers: Monitor,
  settings: Settings,
};

/** A file query shorter than this would match half a repository. */
const FILE_QUERY_MIN = 2;
/** Typing settles for this long before the computer is asked. */
const FILE_SEARCH_DELAY_MS = 180;
/** Enough to pick from; a longer list is a sign to type one more letter. */
const FILE_RESULT_LIMIT = 12;

/** What the computer answered for one query: its first files, whether there were more, or that it could not say. */
type FileAnswer = { query: string; files: PaletteFile[]; more: boolean; failed: boolean };

/** Enter that commits an input-method candidate is text entry, not a choice. */
function composing(event: KeyboardEvent<HTMLInputElement>): boolean {
  // WebKit ends the composition before this keydown, and marks it only with 229.
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function SessionCopy({ session }: { session: PaletteSession }) {
  return <>
    <AgentAvatar kind={session.kind === "agent" ? session.agentKind : ""}
      status={session.kind === "agent" ? session.statusTone : undefined} />
    <span className="palette-copy">
      <span className="palette-name">{session.title}</span>
      <span className="palette-meta">
        {session.statusLabel ? <span className={`palette-status is-${session.statusTone}`}>{session.statusLabel}</span> : null}
        {session.statusLabel && session.meta ? <span aria-hidden="true"> · </span> : null}
        {session.meta}
      </span>
    </span>
  </>;
}

/**
 * Search and jump.
 *
 * A text field over a list of the sessions and the rail's destinations. Focus
 * never leaves the field: the arrows move a highlight the field points at, Enter
 * takes it, and the dialog closes before the jump runs. It navigates only — a
 * row shows what the list row shows and offers no answer to an agent.
 *
 * Its desk form (the shared dialog lifecycle's answer to the opening gesture)
 * is the panel under the top edge wherever the list sits beside the page,
 * instead of the bottom sheet a finger gets below the roomy width. A window
 * dragged down to the phone layout hands the open palette back to the sheet
 * rather than closing a typed query.
 */
export function CommandPalette({ modal, ports }: { modal: ModalController<PaletteRun>; ports: CommandPalettePorts }) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState(ports.read);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => ports.subscribe(() => setInput(ports.read())), [ports]);
  // The open session's workspace, asked once: the palette does not start searching a workspace the reader moves to under it.
  const [files] = useState(() => ports.files?.() ?? null);
  const [found, setFound] = useState<FileAnswer>({ query: "", files: [], more: false, failed: false });
  const wanted = query.trim();
  // The row Enter would take now. An answer that lands must not move it: see `land`.
  const highlighted = useRef<string | null>(null);
  useEffect(() => {
    if (!files || wanted.length < FILE_QUERY_MIN) return;
    let alive = true;
    const land = (answer: FileAnswer) => {
      if (!alive) return;
      // Files are listed above the actions. The highlight the reader sees stays on its row when they
      // arrive, so an Enter already on its way takes what it was aimed at.
      setActiveKey((key) => key ?? highlighted.current);
      setFound(answer);
    };
    const timer = window.setTimeout(() => {
      files.search(wanted).then(
        (paths) => land({ query: wanted, files: paths.slice(0, FILE_RESULT_LIMIT).map(paletteFile), more: paths.length > FILE_RESULT_LIMIT, failed: false }),
        () => land({ query: wanted, files: [], more: false, failed: true }),
      );
    }, FILE_SEARCH_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [files, wanted]);
  // Results for another query are not this one's: the section waits for its own answer.
  const asked = Boolean(files) && wanted.length >= FILE_QUERY_MIN;
  const answer = asked && found.query === wanted ? found : null;
  const fileHits = answer?.files ?? [];
  const deskForm = useDialogLifecycle({ dialog: modal.dialog, onDismiss: modal.dismiss, onClose: modal.finish, cancelGuardMs: 0,
    focus: () => field.current?.focus() });

  const palette = buildPalette(input, query, fileHits);
  const active = activeItem(palette.items, activeKey);
  highlighted.current = active?.key ?? null;
  // One line under the list for what the rows cannot say: the files are still being asked for, could
  // not be, are more than the rows shown, or nothing matches at all.
  const note = asked && !answer ? t("palette.searchingFiles")
    : answer?.failed ? t("palette.filesFailed")
    : answer?.more ? t("palette.filesMore", { count: FILE_RESULT_LIMIT })
    : palette.items.length ? null
    : t(files ? "palette.noneFiles" : "palette.none");
  const optionId = (key: string) => `${baseId}-${key}`;
  const activeId = active ? optionId(active.key) : undefined;
  const leads = active !== null && palette.items[0]?.key === active.key;
  useLayoutEffect(() => {
    if (!list.current) return;
    // The first row brings its heading back with it.
    if (leads || !activeId) list.current.scrollTop = 0;
    else document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, leads]);

  const run = (item: PaletteItem) => {
    if (item.type === "session") modal.close(() => ports.openSession(item.paneId));
    else if (item.type === "file") modal.close(() => files?.open(item.path));
    else if (!item.disabled) modal.close(() => ports.runAction(item.action));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveKey(stepActive(palette.items, active?.key ?? null, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) run(active);
    }
  };
  // The field and Close are the only stops, and Tab walks between them: past
  // the last one the browser would park focus on the inert page behind.
  const onTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") return;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
    if (!stops.length) return;
    event.preventDefault();
    const at = stops.indexOf(document.activeElement as HTMLElement);
    stops[event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length].focus();
  };
  const option = (item: PaletteItem) => {
    const selected = item.key === active?.key;
    const disabled = item.type === "action" && item.disabled;
    const Icon = item.type === "action" ? ACTION_ICONS[item.action] : null;
    return (
      <div key={item.key} id={optionId(item.key)} role="option" aria-selected={selected} aria-disabled={disabled || undefined}
        className={`palette-row is-${item.type}${selected ? " is-active" : ""}`}
        data-pane-id={item.type === "session" ? item.paneId : undefined}
        // The field keeps focus, and a resting pointer does not steal the
        // highlight when the list scrolls under it.
        onMouseDown={(event) => event.preventDefault()}
        onPointerMove={() => { if (!disabled && !selected) setActiveKey(item.key); }}
        onClick={() => run(item)}>
        {item.type === "session" ? <SessionCopy session={item} /> : item.type === "file" ? <>
          <span className="palette-icon"><File size={18} aria-hidden="true" /></span>
          <span className="palette-copy">
            <span className="palette-name palette-file-name">{item.name}</span>
            {item.folder ? <span className="palette-meta palette-file-folder">{item.folder}</span> : null}
          </span>
        </> : <>
          {Icon ? <span className="palette-icon"><Icon size={18} aria-hidden="true" /></span> : null}
          <span className="palette-copy"><span className="palette-label">{item.label}</span></span>
        </>}
        {selected ? <kbd className="palette-enter" aria-hidden="true">↵</kbd> : null}
      </div>
    );
  };

  return (
    <dialog ref={modal.dialog} className={dialogClass("modal command-palette", deskForm)} aria-label={t("palette.title")}
      data-react-modal="" onKeyDown={onTab}>
      <form ref={modal.form} method="dialog" className="palette" onSubmit={(event) => event.preventDefault()}>
        <div className="palette-field">
          <Search size={18} aria-hidden="true" />
          <input ref={field} className="palette-input" type="text" role="combobox" aria-expanded="true"
            aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
            aria-label={t("palette.title")} placeholder={t(files ? "palette.placeholderFiles" : "palette.placeholder")}
            autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="go"
            value={query} onKeyDown={onKeyDown}
            onChange={(event) => { setQuery(event.currentTarget.value); setActiveKey(null); }} />
          <button type="button" className="palette-close" aria-label={t("close")} onClick={modal.dismiss}>
            <kbd aria-hidden="true">esc</kbd><X size={18} aria-hidden="true" />
          </button>
        </div>
        {/* Operated from the field; a scroller would otherwise be a keyboard stop of its own. */}
        <div ref={list} id={listId} className="palette-list" role="listbox" tabIndex={-1} aria-label={t("palette.results")}>
          {palette.sections.map((section) => {
            const headId = `${baseId}-head-${section.id}`;
            return (
              <div key={section.id} className="palette-section" role="group" aria-labelledby={headId}>
                <div id={headId} className="palette-head" role="presentation">{section.title}</div>
                {section.items.map(option)}
              </div>
            );
          })}
        </div>
        {note ? <p className={`palette-none${palette.items.length ? " is-note" : ""}`} role="status">{note}</p> : null}
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t("palette.hintMove")}</span>
          <span><kbd>↵</kbd>{t("palette.hintOpen")}</span>
          <span><kbd>esc</kbd>{t("palette.hintClose")}</span>
        </div>
      </form>
    </dialog>
  );
}
