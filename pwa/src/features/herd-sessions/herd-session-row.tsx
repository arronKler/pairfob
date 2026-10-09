import { ChevronsUpDown, Layers } from "lucide-react";
import { useSyncExternalStore } from "react";
import { computersStore, liveSession } from "../computers/catalog-store";
import { t } from "../../lib/i18n";
import type { HerdSessionSummary, LiveSession } from "../../lib/protocol/session-types";
import { MenuChoice, showActionSheet } from "../../shared/ui/overlay";
import { Button, SetNavItem } from "../../shared/ui/primitives";
import { chooseHerdSession } from "./actions";
import { herdSessionList, subscribeHerdSessions, type HerdSessionList } from "./store";

function herdSessionLabel(name: string | null): string {
  return name ?? t("set.herdSessionDefault");
}

function hasHerdSessionChoice(sessions: readonly HerdSessionSummary[], current: string | null): boolean {
  return current !== null || sessions.some(session => session.name !== null && session.running);
}

function openHerdSessionSheet(sessions: readonly HerdSessionSummary[], current: string | null): void {
  showActionSheet(t("set.herdSessionTitle"), (modal) => <>
    {sessions.map(({ name, running }) => (
      <MenuChoice key={name ?? ""} modal={modal} title={herdSessionLabel(name)}
        detail={running ? t("set.herdSessionRunning") : t("set.herdSessionStopped")}
        selected={name === current} action={() => chooseHerdSession(name)} />
    ))}
  </>, { popover: "menu" });
}

/**
 * The live connection's session list and selection. The value is read from the
 * connection, so it names exactly the session RPCs target, including after a
 * computer switch; there is no list for an old or opted-out daemon.
 */
function useHerdSessionChoice(): { session: LiveSession | null; list: HerdSessionList | undefined; current: string | null } {
  const session = useSyncExternalStore(computersStore.subscribe, liveSession);
  const list = useSyncExternalStore(subscribeHerdSessions, () => herdSessionList(session));
  const current = useSyncExternalStore(subscribeHerdSessions, () => session?.herdSession?.() ?? null);
  return { session, list, current };
}

/** The Herdr-session row under the Settings computer panel. */
export function HerdSessionRow() {
  const { session, list, current } = useHerdSessionChoice();
  if (!session || !list || !hasHerdSessionChoice(list.sessions, current)) return null;
  return <SetNavItem label={t("set.herdSession")} value={herdSessionLabel(current)}
    onClick={() => openHerdSessionSheet(list.sessions, current)} />;
}

/**
 * The same switch on the Sessions tab: a pill in the phone header, and in the
 * desktop rail a row of its own under the head, so a named session is one tap
 * from the list it changes. The rail's head is the computer's; a third control
 * beside it would cut the name short. The row has the width to say what it
 * switches as well as which one is chosen.
 */
export function HerdSessionSwitch({ row = false }: { row?: boolean }) {
  const { session, list, current } = useHerdSessionChoice();
  if (!session || !list || !hasHerdSessionChoice(list.sessions, current)) return null;
  const label = herdSessionLabel(current);
  return (
    <Button className="herd-session-switch" aria-haspopup="dialog" aria-label={t("set.herdSessionAria", { name: label })}
      onClick={() => openHerdSessionSheet(list.sessions, current)}>
      <Layers size={16} aria-hidden="true" />
      {row ? <span className="herd-session-kind">{t("set.herdSession")}</span> : null}
      <span className="herd-session-name">{label}</span>
      {row ? <ChevronsUpDown size={14} aria-hidden="true" /> : null}
    </Button>
  );
}
