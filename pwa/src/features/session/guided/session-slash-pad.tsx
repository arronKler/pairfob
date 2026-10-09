import { useDashboard } from "../../dashboard/hooks";
import { useSession } from "../hooks";
import { usePreferences } from "../../settings/hooks";
import { defaultQuickCommands, editQuickCommand, type QuickCommandReorder } from "../keypad/quick-command-editor";
import { bindCommandDrag } from "../keypad/command-drag";
import { composeDraft } from "../compose-store";
import { Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PadPages, type PageMemory } from "../keypad/pad-pages";
import { KEY_PAGES } from "../keypad/keys";
import { slashCommandsForAgent, type SlashCommand } from "../../../lib/slash-commands";
import { t } from "../../../lib/i18n";
import { showStatus } from "../../../app/notices-store";
import { padKind, setQuickCommands } from "../../settings/preferences-store";
import { addQuickCommand, arrangeCommandPad, moveQuickCommand, stepQuickCommand, QUICK_COMMAND_LIMIT,
  type QuickCommand } from "../../settings/quick-command-model";
import { selectPadKind } from "./slash-pad";
import { insertQuickCommand, insertSlashCommand } from "./compose";
import { PadChromeButton } from "../compose-focus";

/** How long a deleted command can be brought back from the pad itself. */
const UNDO_MS = 5000;

/** 按键 | 命令, on the right of the pagination row so the primary row never changes shape. */
export function SessionPadModeBar({ onRepaint = () => undefined }: { onRepaint?: () => void }) {
  const current = padKind();
  return <div className="pad-kind" role="group" aria-label={t("slash.padKind")}>
    {(["keys", "slash"] as const).map(kind => <PadChromeButton
      key={kind} type="button" className="pad-kind-option" aria-pressed={current === kind ? "true" : "false"}
      onClick={() => selectPadKind(kind, onRepaint)}
    >{t(kind === "keys" ? "slash.keys" : "slash.commands")}</PadChromeButton>)}
  </div>;
}

type EditHandlers = {
  open: (command: QuickCommand) => void;
  remove: (command: QuickCommand) => void;
  drop: (id: string, to: number) => void;
};

/** An own command in edit mode: tap edits it, a drag moves it, × deletes it. */
function EditableCommand({ command, index, handlers }: { command: QuickCommand; index: number; handlers: { current: EditHandlers } }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return bindCommandDrag(el, to => handlers.current.drop(command.id, to));
  }, [command.id, handlers]);
  return <div className="pad-cell is-editing" data-pad-index={index}>
    <button ref={ref} type="button" className="key quick-cmd is-editing" data-pad-drag=""
      aria-label={t("pad.editCommand", { label: command.label })}
      onClick={() => handlers.current.open(command)}>{command.label}</button>
    <button type="button" className="pad-cell-remove" aria-label={t("pad.remove", { label: command.label })}
      onClick={() => handlers.current.remove(command)}><X size={11} strokeWidth={3} aria-hidden="true" /></button>
  </div>;
}

/**
 * Pinned commands, then the agent's slash commands, then the rest. "编辑"
 * edits in place: what the reader arranges here is exactly where each command
 * shows up. Edit mode is local, so collapsing the pad leaves it.
 */
function CommandPad({ agent, slash, commands, onSelect, onCustomSelect, memory, rows }: {
  agent: string; slash: SlashCommand[]; commands: readonly QuickCommand[]; memory: PageMemory; rows: 1 | 2;
  onSelect: (token: string) => void; onCustomSelect: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [removed, setRemoved] = useState<{ label: string; previous: readonly QuickCommand[] } | null>(null);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [removed]);
  const latest = useRef(commands);
  latest.current = commands;
  const remove = (command: QuickCommand) => {
    const previous = latest.current;
    if (setQuickCommands(previous.filter(item => item.id !== command.id))) setRemoved({ label: command.label, previous });
  };
  const create = async () => {
    const edit = await editQuickCommand({ draft: composeDraft() });
    if (edit?.action !== "save") return;
    const added = addQuickCommand(latest.current, { id: crypto.randomUUID(), label: edit.label, text: edit.text });
    if (!added) { showStatus(t("pad.limit")); return; }
    if (setQuickCommands(added.commands) && added.placement === "last") showStatus(t("pad.addedLast"));
  };
  const handlers = useRef<EditHandlers>(null!);
  handlers.current = {
    remove,
    async open(command) {
      // Reads the saved list on every step: the sheet stays open across moves.
      const reorder: QuickCommandReorder = {
        can: direction => stepQuickCommand(latest.current, command.id, direction, slash.length) !== null,
        step(direction) {
          const before = latest.current.find(item => item.id === command.id)?.pinned;
          const next = stepQuickCommand(latest.current, command.id, direction, slash.length);
          if (next === null || next === "pins-full") return next;
          if (!setQuickCommands(next)) return null;
          latest.current = next;
          const after = next.find(item => item.id === command.id)?.pinned;
          return !slash.length || before === after ? "moved" : after ? "pinned" : "unpinned";
        },
      };
      const edit = await editQuickCommand({ command, draft: composeDraft(), reorder });
      if (edit?.action === "delete") remove(command);
      else if (edit?.action === "save") setQuickCommands(latest.current.map(item => item.id === command.id
        ? { ...item, label: edit.label, text: edit.text } : item));
    },
    drop(id, to) {
      const next = moveQuickCommand(latest.current, id, to, slash.length);
      if (next === "pins-full") showStatus(t("pad.pinsFull"));
      else setQuickCommands(next);
    },
  };
  const addFirst = <PadChromeButton key="add-first" type="button" className="key quick-add-first"
    data-pad-index={0} onClick={() => void create()}>
    <Plus size={15} aria-hidden="true" />{t("pad.addFirst")}</PadChromeButton>;
  // An emptied list also offers the stock examples, each one tap to add back.
  const examples = commands.length ? [] : defaultQuickCommands().map(example => <PadChromeButton
    key={`example:${example.id}`} type="button" className="key quick-example"
    aria-label={t("pad.example", { label: example.label })} title={example.text}
    onClick={() => {
      const added = addQuickCommand(latest.current, { id: example.id, label: example.label, text: example.text });
      if (added) setQuickCommands(added.commands);
    }}><Plus size={13} aria-hidden="true" />{example.label}</PadChromeButton>);
  const cells = arrangeCommandPad(commands, slash.length);
  // With no commands of its own the pad offers to add one in the first cells;
  // indices shift so a drop target still names a real position.
  const lead = commands.length ? [] : [addFirst, ...examples];
  const base = lead.length;
  const items: ReactNode[] = [...lead, ...cells.map((cell, position) => {
    const index = position + base;
    if (cell.kind === "slash") {
      const command = slash[cell.index]!;
      return editing
        ? <span key={command.token} className="key slash-cmd is-locked" data-pad-index={index}
          aria-disabled="true" title={t("pad.slashLocked")}>{command.label}</span>
        : <PadChromeButton key={command.token} type="button" className="key slash-cmd" data-pad-index={index}
          aria-label={command.ariaKey ? t(command.ariaKey) : t("slash.insert", { label: command.label })}
          onClick={() => onSelect(command.token)}><span className="pad-cmd-name">{command.label}</span></PadChromeButton>;
    }
    const command = cell.command;
    return editing
      ? <EditableCommand key={`custom:${command.id}`} command={command} index={index} handlers={handlers} />
      : <PadChromeButton key={`custom:${command.id}`} type="button" className="key quick-cmd" data-pad-index={index}
        title={command.text} aria-label={t("quick.insert", { label: command.label })}
        onClick={() => onCustomSelect(command.text)}><span className="pad-cmd-name">{command.label}</span></PadChromeButton>;
  })];
  const header = editing && <p className="pad-edit-hint" role="status">
    {removed
      ? <>{t("pad.removed", { label: removed.label })}<button type="button" className="pad-undo" onClick={() => {
        if (setQuickCommands([...removed.previous])) setRemoved(null);
      }}>{t("pad.undo")}</button></>
      : t("pad.editHint")}
  </p>;
  return <PadPages items={items} columns={4} rows={rows} kind={`slash:${agent}`} label={t("slash.agentCmds")}
    className={`slash-pad${editing ? " is-editing" : ""}`} header={header} memory={memory}
    leading={editing
      ? <PadChromeButton type="button" className="pad-text-btn" aria-label={t("pad.newAria")}
        disabled={commands.length >= QUICK_COMMAND_LIMIT} onClick={() => void create()}>
        <Plus size={13} aria-hidden="true" />{t("pad.new")}</PadChromeButton>
      : <PadChromeButton type="button" className="pad-text-btn" aria-label={t("pad.editAria")}
        onClick={() => setEditing(true)}>{t("pad.edit")}</PadChromeButton>}
    trailing={editing
      ? <PadChromeButton type="button" className="pad-text-btn is-strong"
        onClick={() => { setEditing(false); setRemoved(null); }}>{t("pad.done")}</PadChromeButton>
      : <SessionPadModeBar />} />;
}

/** The key page an item belongs to, whatever number of rows a screen shows of it at a time. */
function keyPageName(firstItem: number): (typeof KEY_PAGES)[number]["name"] {
  let end = 0;
  for (const page of KEY_PAGES) {
    end += page.keys.length;
    if (firstItem < end) return page.name;
  }
  return KEY_PAGES[0].name;
}

/**
 * The expanded pad body: key pages or the command pad. A slash command goes to
 * the start of the draft; a saved command goes in at the caret. Neither sends.
 * `rows` is how many rows a page shows: one on a short landscape screen.
 */
export function SessionSlashPad({ onSelect = insertSlashCommand, onCustomSelect = insertQuickCommand, keyItems, rows = 2 }: {
  onSelect?: (text: string) => void; onCustomSelect?: (text: string) => void; keyItems?: ReactNode[]; rows?: 1 | 2;
}) {
  const { paneId } = useSession();
  const agent = useDashboard().agents.find(item => item.paneId === paneId)?.agent ?? "";
  const preferences = usePreferences();
  const memory = useState<Record<string, number>>({});
  const commands = !keyItems || preferences.padKind === "slash";
  if (commands) return <CommandPad agent={agent} slash={slashCommandsForAgent(agent)} memory={memory} rows={rows}
    commands={preferences.quickCommands ?? defaultQuickCommands()} onSelect={onSelect} onCustomSelect={onCustomSelect} />;
  return <PadPages items={keyItems} columns={7} rows={rows} kind="keys" label={t("keys.more")} memory={memory}
    leading={(_page, firstItem) => <span className="pad-page-name">{t(keyPageName(firstItem))}</span>}
    trailing={<SessionPadModeBar />} />;
}
