import { Pencil, Plus, Search } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DirIndexPort } from "../../lib/dir-index";
import { t } from "../../lib/i18n";
import { OPERATION_INPUT_LIMITS } from "../../lib/operations";
import { SheetFrame } from "../../shared/ui/overlay/action-sheet";
import { useDeskEnter } from "../../shared/ui/overlay/desk-form";
import { useEscapeStep } from "../../shared/ui/overlay/escape-steps";
import { focusRefused } from "../../shared/ui/overlay/form-focus";
import { DeskCancel, presentModal, type ModalController } from "../../shared/ui/overlay/modal";
import { deskInput } from "../../shared/ui/overlay/popover";
import { SheetFooter } from "../../shared/ui/overlay/sheet-content";
import { AgentAvatar, Button, Fold } from "../../shared/ui/primitives";
import { SheetSwap } from "./sheet-swap";
import { AgentKindGrid, kindName } from "./agent-kind-grid";
import { AgentKindPickerPanel } from "./agent-kind-picker";
import type { CreateMemory } from "./create-memory";
import { DirPicker } from "./dir-picker";
import { defaultAgentKind, type SheetOutcome } from "./operation-form-model";

export const NEW_WORKSPACE = "pairfob:new-workspace";

export type CreateWorkspaceOption = { id: string; label: string; path: string };

export type CreateSheetInput = {
  host: string;
  /** Existing workspaces, the entry's own workspace first. */
  workspaces: CreateWorkspaceOption[];
  /** A workspace id, or NEW_WORKSPACE. */
  initial: string;
  /** Advertised agent kinds; the only kinds offered. */
  kinds: readonly string[];
  memory: CreateMemory;
  lastKind: string | null;
  canCreateTab: boolean;
  canCreateWorkspace: boolean;
  canCreateWorktree: boolean;
  /** Directory search, only when the computer advertises search_dirs. */
  dirs?: DirIndexPort;
  /** Directories this phone created before, for the search page's empty state. */
  recents?: string[];
  /** With a new workspace: a directory to start on (e.g. a recent one picked from the empty list). */
  initialDir?: string;
  onCreate?: (request: CreateRequest) => Promise<SheetOutcome>;
};

export type CreateRequest =
  | { kind: "tab"; workspaceId: string; agentKind: string; label: string }
  | { kind: "conversation"; cwd: string; agentKind: string; label: string }
  | { kind: "worktree"; cwd: string; branch: string; base: string; label: string };

/**
 * A block of the form that opens and shuts by height, so choosing another way
 * to start grows the sheet instead of jumping it. What it holds stays mounted
 * and, shut, out of reach. `.create-fold` keeps room inside for the focus ring
 * of the controls it clips.
 */
function FormFold({ open, children }: { open: boolean; children: ReactNode }) {
  return <Fold className="create-fold" open={open}><div className="create-fold-in">{children}</div></Fold>;
}

function CreateSheetBody({ modal, input }: { modal: ModalController<CreateRequest>; input: CreateSheetInput }) {
  const canNew = input.canCreateWorkspace;
  const firstWorkspace = input.canCreateTab ? input.workspaces[0]?.id : undefined;
  const [where, setWhere] = useState(() => input.initial === NEW_WORKSPACE || !input.canCreateTab
    ? (canNew ? NEW_WORKSPACE : firstWorkspace ?? NEW_WORKSPACE)
    : input.initial);
  const [kind, setKind] = useState(() => defaultAgentKind(input.kinds, input.lastKind));
  const [memory, setMemory] = useState(input.memory);
  const [dir, setDir] = useState(input.initialDir ?? "");
  const [otherPath, setOtherPath] = useState<string | null>(null);
  const [start, setStart] = useState<"dir" | "worktree">("dir");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  // A refusal is about the directory: a mouse or keyboard reader is put in
  // its chooser, or in the path being typed (`form-focus`), instead of left on
  // the button. A finger left no keyboard position to move.
  const root = useRef<HTMLDivElement>(null);
  const [refused, setRefused] = useState({ field: "", count: 0 });
  useLayoutEffect(() => { if (refused.count && deskInput()) focusRefused(root.current, refused.field); }, [refused]);
  const refuse = (message: string) => {
    setError(message);
    setRefused(last => ({ field: otherPath === null ? "dir" : "path", count: last.count + 1 }));
  };
  // The full list or the directory search replaces the form in place (not a
  // pushed sheet page: the sheet unmounts its root while a page is up), so the
  // form keeps everything already chosen while the reader browses. It still
  // travels as a page does: the list comes in from the right, the form comes
  // back from the left, and the card eases between their heights (`SheetSwap`).
  const [view, setView] = useState<"form" | "kinds" | "dirs">("form");
  const [back, setBack] = useState(false);
  const leaveView = () => { setView("form"); setBack(true); };
  // Escape takes back the list or the search first, then the sheet.
  useEscapeStep(view !== "form", leaveView);
  // "Another directory" is pressed to type one: that press, and nothing else, puts the reader in the field.
  const pathField = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(0);
  useLayoutEffect(() => { if (typing) pathField.current?.focus(); }, [typing]);
  const isNew = where === NEW_WORKSPACE;
  // Start on the chosen place, not on whichever chip happens to come first.
  const initialWhere = useRef(where).current;
  const worktree = isNew && start === "worktree";
  const workspace = input.workspaces.find((item) => item.id === where);
  const path = otherPath !== null ? otherPath.trim() : dir;
  const openHere = isNew && !worktree ? input.workspaces.find((item) => item.path && item.path === path) : undefined;
  const recentDirs = memory.dirs.filter((item) => !input.workspaces.some((space) => space.path === item));
  const openDirs = input.workspaces.filter((item) => item.path);
  // A directory found by search is in neither list, and the summary alone is a
  // thin answer to "which one did I pick". It takes a row of its own instead,
  // and only once picked: a typed path already shows in its own field.
  const pickedDir = otherPath === null && dir && !recentDirs.includes(dir) && !openDirs.some((space) => space.path === dir) ? dir : "";
  // What a line last said stays in it while it shuts.
  const shownPath = useRef("");
  if (!isNew && workspace?.path) shownPath.current = workspace.path;
  const shownOpen = useRef(openHere);
  if (openHere) shownOpen.current = openHere;

  // An already-open directory becomes a tab there (see submit), so say that.
  const summary = worktree ? t("create.summaryWt", { dir: path || "…" })
    : openHere ? t("create.summaryTab", { workspace: openHere.label, kind: kindName(kind) })
    : isNew ? t("create.summaryWs", { dir: path || "…", kind: kindName(kind) })
      : t("create.summaryTab", { workspace: workspace?.label ?? "", kind: kindName(kind) });

  const finish = (request: CreateRequest) => {
    if (!input.onCreate) { modal.close(request); return; }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    void input.onCreate(request).then(outcome => {
      if (outcome.ok) modal.close(request);
      else setError(outcome.message || t("create.notRun"));
    }).catch(() => setError(t("create.notRun"))).finally(() => {
      submitting.current = false;
      setBusy(false);
    });
  };

  const submit = () => {
    if (submitting.current) return;
    const name = label.trim().slice(0, OPERATION_INPUT_LIMITS.label);
    if (!isNew) {
      if (!workspace) return;
      finish({ kind: "tab", workspaceId: workspace.id, agentKind: kind, label: name });
      return;
    }
    if (!path) { refuse(t("create.needDir")); return; }
    if (path.length > OPERATION_INPUT_LIMITS.cwd) { refuse(t("form.needCwd")); return; }
    if (openHere) {
      finish({ kind: "tab", workspaceId: openHere.id, agentKind: kind, label: name });
      return;
    }
    if (worktree) {
      finish({ kind: "worktree", cwd: path, branch: branch.trim().slice(0, OPERATION_INPUT_LIMITS.branch),
        base: base.trim().slice(0, OPERATION_INPUT_LIMITS.base), label: name });
      return;
    }
    finish({ kind: "conversation", cwd: path, agentKind: kind, label: name });
  };

  // The desk form submits on Enter from its fields and its choices (`useDeskEnter`).
  const submitOnEnter = useDeskEnter(submit);

  if (view === "kinds") {
    return <SheetSwap key="kinds">
      <AgentKindPickerPanel kinds={input.kinds} memory={memory} selected={kind} onBack={leaveView}
        onPick={(next) => { setKind(next); leaveView(); }} onPinsChange={setMemory} />
    </SheetSwap>;
  }
  if (view === "dirs" && input.dirs) {
    return <SheetSwap key="dirs">
      <DirPicker port={input.dirs} current={path} workspaces={input.workspaces}
        recents={input.recents ?? []} onBack={leaveView}
        onPick={(picked) => { setDir(picked); setOtherPath(null); setError(""); leaveView(); }} />
    </SheetSwap>;
  }

  const recents = memory.recents.filter((combo) => input.canCreateTab && input.workspaces.some((space) => space.id === combo.workspaceId)
    && (combo.kind === "" || input.kinds.includes(combo.kind)));

  const dirRow = (value: string, open: boolean) => (
    <Button key={value} className={`menu-item create-dir${otherPath === null && dir === value ? " is-selected" : ""}`}
      aria-pressed={otherPath === null && dir === value} data-choice=""
      onClick={() => { setDir(value); setOtherPath(null); setError(""); }}>
      <span className="create-dir-path">{value}</span>
      {open ? <span className="create-dir-tag">{t("create.dirOpenTag")}</span> : null}
    </Button>
  );

  const form = (
    <div ref={root} className={`create-sheet-body${back ? " is-back" : ""}`} onKeyDown={submitOnEnter}>
      {recents.length ? <>
        <h3 className="create-label">{t("create.recent")}</h3>
        <div className="create-scroll">
          {recents.map((combo) => {
            const space = input.workspaces.find((item) => item.id === combo.workspaceId)!;
            const on = where === combo.workspaceId && kind === combo.kind;
            return (
              <Button key={`${combo.kind}@${combo.workspaceId}`} className={`create-chip is-combo${on ? " on" : ""}`} aria-pressed={on} data-choice=""
                onClick={() => { setWhere(combo.workspaceId); setKind(combo.kind); setError(""); }}>
                <AgentAvatar kind={combo.kind} size="sm" />
                <span>{kindName(combo.kind)}</span>
                <span className="create-chip-sub">{space.label}</span>
              </Button>
            );
          })}
        </div>
      </> : null}

      <h3 className="create-label">{t("create.where")}</h3>
      <div className="create-scroll" role="radiogroup" aria-label={t("create.where")}>
        {/* A new workspace leads the row, so it is never scrolled out of reach. */}
        {canNew ? (
          <Button className={`create-chip is-new${isNew ? " on" : ""}`} role="radio" aria-checked={isNew}
            data-autofocus={initialWhere === NEW_WORKSPACE ? "" : undefined}
            onClick={() => { setWhere(NEW_WORKSPACE); setError(""); }}>
            <Plus size={15} aria-hidden="true" />{t("create.newWorkspace")}
          </Button>
        ) : null}
        {input.canCreateTab ? input.workspaces.map((space) => (
          <Button key={space.id} className={`create-chip${where === space.id ? " on" : ""}`} role="radio" aria-checked={where === space.id}
            data-autofocus={initialWhere === space.id ? "" : undefined}
            onClick={() => { setWhere(space.id); setError(""); }}>{space.label}</Button>
        )) : null}
      </div>
      <Fold open={!isNew && !!workspace?.path}><p className="create-path">{shownPath.current}</p></Fold>

      <FormFold open={isNew}>
        <p className="create-hint">{t("create.pathHelp", { host: input.host })}</p>
        <div className="create-dirs" data-field="dir">
          {pickedDir ? <p className="create-dir-group">{t("create.dirPicked")}</p> : null}
          {pickedDir ? dirRow(pickedDir, false) : null}
          {recentDirs.length ? <p className="create-dir-group">{t("create.dirRecent")}</p> : null}
          {recentDirs.map((value) => dirRow(value, false))}
          {openDirs.length ? <p className="create-dir-group">{t("create.dirOpen")}</p> : null}
          {openDirs.map((space) => dirRow(space.path, true))}
          {input.dirs ? (
            <Button className="menu-item create-dir" onClick={() => { setView("dirs"); setBack(false); }}>
              <Search size={16} aria-hidden="true" />
              <span className="create-dir-path">{t("create.dirSearch")}</span>
            </Button>
          ) : null}
          <Button className={`menu-item create-dir${otherPath !== null ? " is-selected" : ""}`} aria-expanded={otherPath !== null}
            onClick={() => { setOtherPath(otherPath ?? ""); setTyping(count => count + 1); }}>
            <Pencil size={16} aria-hidden="true" />
            <span className="create-dir-path">{t("create.dirOther")}</span>
          </Button>
          <Fold open={otherPath !== null}>
            <input ref={pathField} className="create-input is-mono" type="text" name="path" value={otherPath ?? ""}
              placeholder={t("create.pathPlaceholder")} aria-label={t("create.dirOther")} maxLength={OPERATION_INPUT_LIMITS.cwd}
              autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={(event) => { setOtherPath(event.currentTarget.value); setError(""); }} />
          </Fold>
        </div>
        <FormFold open={!!openHere}>
          <p className="create-hint">
            {t("create.alreadyOpen", { name: shownOpen.current?.label ?? "" })}{" "}
            <Button className="text-link" onClick={() => { if (openHere) setWhere(openHere.id); }}>{t("create.useOpen")}</Button>
          </p>
        </FormFold>
        {input.canCreateWorktree ? <>
          <h3 className="create-label">{t("create.start")}</h3>
          <div className="seg create-seg" role="radiogroup" aria-label={t("create.start")}>
            <button type="button" className={`seg-item${start === "dir" ? " on" : ""}`} role="radio" aria-checked={start === "dir"}
              onClick={() => setStart("dir")}>{t("create.startBranch")}</button>
            <button type="button" className={`seg-item${start === "worktree" ? " on" : ""}`} role="radio" aria-checked={start === "worktree"}
              onClick={() => setStart("worktree")}>{t("create.startWorktree")}</button>
          </div>
          <FormFold open={worktree}>
            <label className="create-field">{t("create.branch")}
              <input className="create-input is-mono" type="text" value={branch} placeholder={t("create.branchHint")}
                maxLength={OPERATION_INPUT_LIMITS.branch} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(event) => setBranch(event.currentTarget.value)} />
            </label>
            <label className="create-field">{t("create.base")}
              <input className="create-input is-mono" type="text" value={base} placeholder={t("create.baseHint")}
                maxLength={OPERATION_INPUT_LIMITS.base} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(event) => setBase(event.currentTarget.value)} />
            </label>
          </FormFold>
        </> : null}
      </FormFold>

      <h3 className="create-label">{t("create.what")}</h3>
      {/* A worktree opens with a terminal: the note takes the grid's place, each folding the other way. */}
      <Fold open={worktree}><p className="create-hint">{t("create.worktreeTerminal")}</p></Fold>
      <FormFold open={!worktree}>
        <p className="create-hint">{t("create.agentHelp")}</p>
        <AgentKindGrid kinds={input.kinds} memory={memory} selected={kind} lastKind={input.lastKind}
          onSelect={setKind} onShowAll={() => { setView("kinds"); setBack(false); }} />
      </FormFold>
      {!input.kinds.length && !worktree ? <p className="create-hint">{t("create.noKinds")}</p> : null}

      <label className="create-field">
        <span>{isNew ? t("create.wsName") : t("create.tabName")} <span className="create-optional">{t("create.optional")}</span></span>
        <input className="create-input" type="text" value={label} maxLength={OPERATION_INPUT_LIMITS.label} autoComplete="off"
          placeholder={isNew ? t("create.nameWsHint") : t("create.nameTabHint", { kind: kindName(kind) })}
          onChange={(event) => setLabel(event.currentTarget.value)} />
      </label>

      <SheetFooter>
        <div className="create-footer">
          <p className="create-summary">{summary}</p>
          {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
          <DeskCancel />
          <Button className="btn btn-primary create-submit" disabled={busy} aria-busy={busy} onClick={submit}>{t("create.submit")}</Button>
        </div>
      </SheetFooter>
    </div>
  );
  return <SheetSwap key="form">{form}</SheetSwap>;
}

/** The one create sheet every entry opens. Resolves to what to create, or null. */
export function askCreate(input: CreateSheetInput): Promise<CreateRequest | null> {
  return presentModal<CreateRequest>((modal) => (
    <SheetFrame modal={modal} title={t("create.title")} subtitle={t("create.sub", { host: input.host })} className="create-sheet">
      <CreateSheetBody modal={modal} input={input} />
    </SheetFrame>
  )).result;
}
