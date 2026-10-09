/**
 * Search-and-jump view model.
 *
 * Pure projection over the herd list's own view model: the rows are the list's
 * cards and the actions are the rail's entries, so the palette can show nothing
 * the list does not already know. It never reads a pane's screen, the DOM or
 * application state; the caller hands in one snapshot and a query.
 */
import { t } from "../../../lib/i18n";
import type { HerdCardView, HerdViewModel } from "../../dashboard/model/herd-view";

export type PaletteInput = {
  /**
   * The herd list projected flat: its cards carry the workspace in their own
   * line, since the palette has no group heading to say it.
   */
  view: HerdViewModel;
  /** The reader's own opens, pane id to time; the order of "recent". */
  activated: Readonly<Record<string, number>>;
  /** The session the main column shows now, or "". "Recent" leaves it out. */
  currentPaneId: string;
};

export type PaletteSession = {
  type: "session";
  /** Stable across re-reads, so the highlighted row survives a list update. */
  key: string;
  paneId: string;
  kind: HerdCardView["kind"];
  agentKind: string;
  title: string;
  /** Status word for an agent; empty for a plain terminal. */
  statusLabel: string;
  statusTone: HerdCardView["statusTone"];
  /** Agent, place and tab, without the status. */
  meta: string;
  waiting: boolean;
};

export type PaletteActionId = "create" | "board" | "computers" | "settings";

export type PaletteAction = {
  type: "action";
  key: string;
  action: PaletteActionId;
  label: string;
  /** Shown but not runnable, exactly while the rail's own button is disabled. */
  disabled: boolean;
};

export type PaletteItem = PaletteSession | PaletteAction;

export type PaletteSection = {
  id: "waiting" | "recent" | "sessions" | "actions";
  title: string;
  items: PaletteItem[];
};

export type PaletteView = {
  sections: PaletteSection[];
  /** Every item in display order: what the arrow keys walk. */
  items: PaletteItem[];
};

/** Enough to switch between the sessions in hand without turning into a second list. */
const RECENT_LIMIT = 5;
/** A query narrows; past this the reader should type one more letter. */
const RESULT_LIMIT = 30;

/** Words an action answers to in any language, beside its visible label. */
const ACTION_WORDS: Record<PaletteActionId, string> = {
  create: "new create session",
  board: "board canvas",
  computers: "computer switch host",
  settings: "settings preferences",
};

type SessionEntry = {
  session: PaletteSession;
  /** Lower-cased text a query is matched against, the title first. */
  fields: string[];
  activated: number;
  /** Position in the list, the last tie-break so equal rows keep the list's order. */
  index: number;
};

function sessionEntries(input: PaletteInput): SessionEntry[] {
  return input.view.groups.flatMap((group) => group.cards).map((card, index) => ({
    session: {
      type: "session",
      key: `session:${card.paneId}`,
      paneId: card.paneId,
      kind: card.kind,
      agentKind: card.agentKind,
      title: card.title,
      statusLabel: card.statusLabel,
      statusTone: card.statusTone,
      meta: card.meta,
      waiting: card.blocked,
    },
    fields: [card.title, card.agent.agent, card.agent.displayAgent, card.agent.workspaceLabel,
      card.agent.workspaceCwd, card.agent.cwd, card.agent.tabLabel, card.statusLabel]
      .map((field) => field?.trim().toLowerCase() ?? ""),
    activated: input.activated[card.paneId] ?? 0,
    index,
  }));
}

/**
 * The sessions the "needs you" strip lists, in its order: waiting first, then
 * finished and not yet read.
 */
export function attentionSessions(input: PaletteInput): PaletteSession[] {
  const byPane = new Map(sessionEntries(input).map((entry) => [entry.session.paneId, entry.session]));
  return input.view.attention.flatMap((item) => byPane.get(item.paneId) ?? []);
}

/**
 * Sessions waiting on the reader. A finished session is not waiting: opening it
 * marks it read, so it is never the palette's default target.
 */
export function waitingSessions(input: PaletteInput): PaletteSession[] {
  return attentionSessions(input).filter((session) => session.waiting);
}

/** The rail's entries, hidden or disabled exactly when the rail's are. */
export function paletteActions(view: HerdViewModel): PaletteAction[] {
  const action = (id: PaletteActionId, label: string, disabled = false): PaletteAction =>
    ({ type: "action", key: `action:${id}`, action: id, label, disabled });
  return [
    ...(view.create ? [action("create", t("palette.create"), view.create.disabled)] : []),
    // Already the page beside the list: there is nowhere to go.
    ...(view.board.current ? [] : [action("board", t("palette.board"))]),
    action("computers", t("palette.computers")),
    action("settings", t("palette.settings")),
  ];
}

function normalize(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

const WORD_BREAK = /[\s/\\._:@-]+/;

/**
 * How well one item answers a query: 0 when its name starts with it, 1 when any
 * other field or word does, 2 when every typed word merely appears somewhere,
 * and -1 when it does not match.
 */
function matchRank(fields: readonly string[], query: string): number {
  if (fields[0]?.startsWith(query)) return 0;
  if (fields.some((field) => field.startsWith(query) || field.split(WORD_BREAK).some((word) => word.startsWith(query)))) return 1;
  return query.split(" ").every((term) => fields.some((field) => field.includes(term))) ? 2 : -1;
}

function section(id: PaletteSection["id"], title: string, items: PaletteItem[]): PaletteSection[] {
  return items.length ? [{ id, title, items }] : [];
}

function view(sections: PaletteSection[]): PaletteView {
  return { sections, items: sections.flatMap((item) => item.items) };
}

/**
 * Project the palette for one query.
 *
 * With nothing typed it leads with the sessions waiting on the reader, so
 * opening the palette and pressing Enter goes to the next one; then the sessions
 * the reader opened last, then the actions. A query filters sessions and
 * actions; a workspace is found through its sessions, which match on its name
 * and path.
 */
export function buildPalette(input: PaletteInput, rawQuery: string): PaletteView {
  const entries = sessionEntries(input);
  const actions = paletteActions(input.view);
  const query = normalize(rawQuery);
  if (!query) {
    const waiting = waitingSessions(input);
    const rest = entries.filter((entry) => !entry.session.waiting && entry.session.paneId !== input.currentPaneId);
    const opened = rest.filter((entry) => entry.activated > 0)
      .sort((left, right) => right.activated - left.activated || left.index - right.index);
    // Nothing opened from this device yet: the top of the list stands in, under
    // a heading that does not claim a history.
    const shown = (opened.length ? opened : rest).slice(0, RECENT_LIMIT).map((entry) => entry.session);
    return view([
      ...section("waiting", t("palette.waiting", { count: String(waiting.length) }), waiting),
      ...section(opened.length ? "recent" : "sessions", t(opened.length ? "palette.recent" : "palette.sessions"), shown),
      ...section("actions", t("palette.actions"), actions),
    ]);
  }
  const sessions = entries
    .map((entry) => ({ entry, rank: matchRank(entry.fields, query) }))
    .filter((match) => match.rank >= 0)
    .sort((left, right) => Number(right.entry.session.waiting) - Number(left.entry.session.waiting)
      || left.rank - right.rank
      || right.entry.activated - left.entry.activated
      || left.entry.index - right.entry.index)
    .slice(0, RESULT_LIMIT)
    .map((match) => match.entry.session);
  const matchedActions = actions
    .map((action) => ({ action, rank: matchRank([action.label.toLowerCase(), ACTION_WORDS[action.action]], query) }))
    .filter((match) => match.rank >= 0)
    .sort((left, right) => left.rank - right.rank)
    .map((match) => match.action);
  return view([
    ...section("sessions", t("palette.sessions"), sessions),
    ...section("actions", t("palette.actions"), matchedActions),
  ]);
}

function runnable(item: PaletteItem): boolean {
  return item.type === "session" || !item.disabled;
}

/** The item Enter acts on: the highlighted one while it is still listed and runnable, else the first that is. */
export function activeItem(items: readonly PaletteItem[], key: string | null): PaletteItem | null {
  return items.find((item) => item.key === key && runnable(item)) ?? items.find(runnable) ?? null;
}

/** The next runnable item in a direction, wrapping at either end. */
export function stepActive(items: readonly PaletteItem[], key: string | null, delta: 1 | -1): string | null {
  const targets = items.filter(runnable);
  if (!targets.length) return null;
  const current = targets.findIndex((item) => item.key === activeItem(items, key)?.key);
  return targets[(current + delta + targets.length) % targets.length].key;
}
