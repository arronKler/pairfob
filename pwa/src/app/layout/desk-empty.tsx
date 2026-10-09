import { ChevronRight, Plus, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { useSyncExternalStore } from "react";
import { attentionSessions, openCommandPalette, provideCommandPalette, type PaletteInput, type PaletteSession } from "../../features/command-palette";
import { computersStore } from "../../features/computers/catalog-store";
import { connectionStore } from "../../features/connection/connection-store";
import { runtimeStore } from "../../features/connection/runtime-store";
import { createHerdActions } from "../../features/dashboard/actions";
import { dashboardStore } from "../../features/dashboard/catalog-store";
import { CommandLine } from "../../features/dashboard/components/herd-empty";
import { buildHerdViewModel, type HerdEmptyAction, type HerdEmptyView, type HerdViewModel } from "../../features/dashboard/model/herd-view";
import { capabilitiesStore } from "../../features/operations/capabilities-store";
import { openPaneId, sessionStore } from "../../features/session/session-store";
import { preferencesStore } from "../../features/settings/preferences-store";
import { t } from "../../lib/i18n";
import { createDomainUpdates, useDomainUpdates, type DomainWatch } from "../../pages/domain-updates";
import { herdActionPorts, readHerdAttention, readHerdInput, subscribeHerdAttention } from "../../pages/home/herd-bridge";
import { AgentAvatar, Button } from "../../shared/ui/primitives";
import { commandKOffered, useHardwareKeyboard } from "../input-mode";
import { getLayout, layoutStore } from "../layout-store";
import { navigationStore } from "../navigation-store";

/**
 * The desk's jump source: the herd, read through the home bridge, for the two
 * places that leave the list to go somewhere — the empty main column below and
 * search-and-jump, which is opened from the rail and the keyboard and so cannot
 * import the bridge itself.
 *
 * Both read the list projected flat, whose cards name their workspace, and both
 * fire the list's own actions, so a jump is a click on the row it stands for.
 */
const watches: DomainWatch[] = [
  { store: dashboardStore },
  { store: preferencesStore },
  { store: capabilitiesStore },
  { store: connectionStore },
  { store: computersStore },
  { store: runtimeStore },
  { store: sessionStore },
  { store: navigationStore, keyOf: (snapshot) => (snapshot as { screen: string }).screen },
  { store: layoutStore },
];

const updates = createDomainUpdates(watches);
const actions = createHerdActions(herdActionPorts());

function readJump(): PaletteInput {
  const layout = getLayout();
  const showsSession = !!layout && (layout.deskChild !== null || layout.mode === "pane" || layout.mode === "chat"
    || layout.mode === "full-terminal");
  return {
    view: buildHerdViewModel({ ...readHerdInput(readHerdAttention()), listGroup: "flat" }),
    activated: preferencesStore.get().paneActivated,
    currentPaneId: showsSession ? openPaneId() : "",
  };
}

function subscribeJump(listener: () => void): () => void {
  const releases = [updates.subscribe(listener), subscribeHerdAttention(listener)];
  return () => {
    for (const release of releases) release();
  };
}

provideCommandPalette({
  read: readJump,
  subscribe: subscribeJump,
  openSession: (paneId) => actions.openPaneFromCard(paneId, null),
  runAction(action) {
    if (action === "create") actions.createConversation();
    else if (action === "board") actions.openBoard();
    else if (action === "computers") actions.openComputers();
    else actions.openSettings();
  },
});

/**
 * What the list being empty means, said in the main column: a heading, one
 * line, and whatever the reader can do about it from here. The rail beside it
 * only notes the fact (`HerdEmpty`, `beside`).
 */
export type DeskEmptyState = {
  title: string;
  sub: string;
  /** A command to run on the computer, shown copyable under the line; empty when none helps. */
  command: string;
  /** Retry, connection details: the list's own way out of a state that does not mend itself. */
  actions: HerdEmptyView["actions"];
  /**
   * Starting a session and finding one. `open` on a computer that is simply
   * empty. `held` while the list is still being read: both are drawn where
   * they will be and cannot be pressed, so nothing moves when the list
   * arrives. `none` while the list cannot be read at all: a session cannot be
   * started then, and there is none to find.
   */
  entries: "open" | "held" | "none";
};

/** The main column's words for an empty list; null when the list has rows. */
export function deskEmptyState(view: Pick<HerdViewModel, "groups" | "loading" | "empty">): DeskEmptyState | null {
  if (view.groups.length) return null;
  if (view.loading) {
    return { title: t("deskEmpty.readingTitle"), sub: t("deskEmpty.readingSub"), command: "", actions: [], entries: "held" };
  }
  const empty = view.empty;
  if (!empty) return null;
  switch (empty.kind) {
    case "none":
      return { title: empty.title, sub: t("deskEmpty.firstSub"), command: "", actions: [], entries: "open" };
    case "noCreate":
      return { title: empty.title, sub: t("deskEmpty.firstOpenSub"), command: empty.command, actions: [], entries: "open" };
    case "offline":
      return { title: t("deskEmpty.offlineTitle"), sub: empty.sub, command: "", actions: [], entries: "none" };
    case "reconnecting":
      return { title: t("empty.reconnectingTitle"), sub: empty.sub, command: "", actions: [], entries: "none" };
    default:
      // Herdr gone or silent: the list's own title, line, command and ways out.
      return { title: empty.title, sub: empty.sub, command: empty.command, actions: empty.actions, entries: "none" };
  }
}

type DeskEmptyProps = {
  /** The "needs you" strip's sessions in its order: waiting first, then finished and unread. */
  attention: readonly PaletteSession[];
  /** The list has rows to pick from. */
  hasSessions: boolean;
  /** Why the list has none, when it has none. */
  state: DeskEmptyState | null;
  /** The rail's create entry: absent without the capability, disabled while it cannot run. */
  create: { disabled: boolean } | null;
  shortcut: boolean;
  /** `source` is the entry's title, handed over as a list row hands over its own. */
  onOpen(paneId: string, source: HTMLElement | null): void;
  onCreate(): void;
  onSearch(): void;
  /** One of `state.actions`, run as the list's empty panel runs it. */
  onAction(kind: HerdEmptyAction): void;
};

const ACTION_ICON: Record<HerdEmptyAction, typeof Plus> = { create: Plus, retry: RefreshCw, details: SlidersHorizontal };

/**
 * The desk main column when no session is open: the sessions that need the
 * reader, then a way to start one and a way to find one. It only leads into a
 * session — answering an agent means reading its screen first, and that stays
 * inside the session.
 *
 * Whatever it shows, it is one heading, one line and the actions that fit:
 * the sessions that wait, the prompt to pick one, or what an empty list means
 * (`DeskEmptyState`): nothing here yet, still reading, or why it cannot be
 * read and what to do about it.
 */
export function DeskEmptyView({ attention, hasSessions, state, create, shortcut, onOpen, onCreate, onSearch, onAction }: DeskEmptyProps) {
  const count = String(attention.length);
  const said = !attention.length && !hasSessions ? state : null;
  const entries = said?.entries ?? "open";
  const held = entries === "held";
  return (
    <div className="main-empty desk-empty">
      {attention.length ? <>
        <h2 className="desk-empty-title">
          {t(attention.every((session) => session.waiting) ? "deskEmpty.waiting" : "deskEmpty.needsYou", { count })}
        </h2>
        <ul className="desk-ticket-list" aria-label={t("list.needsYouAria")}>
          {attention.map((session) => (
            <li key={session.paneId}>
              <Button className={`desk-ticket is-${session.waiting ? "blocked" : "done"}`} data-pane-id={session.paneId}
                onClick={(event) => onOpen(session.paneId, event.currentTarget.querySelector<HTMLElement>(".desk-ticket-name"))}>
                <AgentAvatar kind={session.agentKind} status={session.statusTone} size="lg" />
                <span className="desk-ticket-copy">
                  <span className="desk-ticket-name">{session.title}</span>
                  <span className="desk-ticket-meta">
                    <span className={`desk-ticket-status is-${session.statusTone}`}>{session.statusLabel}</span>
                    {session.meta ? <><span aria-hidden="true"> · </span>{session.meta}</> : null}
                  </span>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      </> : hasSessions ? <>
        <p className="empty-title">{t("desk.pickTitle")}</p>
        <p className="empty-sub">{t("desk.pickSub")}</p>
      </> : said ? <>
        <h2 className="empty-title" role={held ? "status" : undefined}>{said.title}</h2>
        <p className="empty-sub">{said.sub}</p>
        {said.command ? <CommandLine command={said.command} label={t("empty.runOnComputer")} /> : null}
      </> : null}
      {entries === "none" ? (said?.actions.length ? (
        <div className="desk-empty-actions">
          {said.actions.map((action) => {
            const Icon = ACTION_ICON[action.kind];
            return (
              <Button key={action.kind} className={`btn btn-small${action.primary ? " btn-primary" : ""}`} disabled={action.disabled}
                onClick={() => onAction(action.kind)}>
                <Icon size={16} aria-hidden="true" />{action.label}
              </Button>
            );
          })}
        </div>
      ) : null) : (
        <div className="desk-empty-actions">
          {create || held ? (
            <Button className="btn btn-small btn-primary" disabled={held || create?.disabled} onClick={onCreate}>
              <Plus size={16} aria-hidden="true" />{t("empty.actionCreate")}
            </Button>
          ) : null}
          <Button className="btn btn-small desk-empty-search" aria-haspopup="dialog" disabled={held} onClick={onSearch}>
            <Search size={16} aria-hidden="true" />{t("deskEmpty.search")}
            {shortcut ? <kbd aria-hidden="true">⌘K</kbd> : null}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The empty main over the live herd; every button is the list's or the rail's own action. */
export function DeskEmpty() {
  useSyncExternalStore(subscribeHerdAttention, readHerdAttention);
  useDomainUpdates(updates);
  // The shortcut hint follows the keyboard: a tablet gains it with its first physical key.
  useHardwareKeyboard();
  const jump = readJump();
  return <DeskEmptyView attention={attentionSessions(jump)} hasSessions={jump.view.groups.length > 0} state={deskEmptyState(jump.view)}
    create={jump.view.create} shortcut={commandKOffered()}
    onOpen={actions.openPaneFromCard} onCreate={actions.createConversation} onSearch={openCommandPalette}
    onAction={actions.runEmptyAction} />;
}
