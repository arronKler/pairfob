import { LayoutDashboard, Plus, Search, Settings } from "lucide-react";
import { useSyncExternalStore } from "react";
import { commandKOffered, useHardwareKeyboard } from "../../../app/input-mode";
import { t } from "../../../lib/i18n";
import { useObjectPress } from "../../../shared/ui/overlay";
import { popoverTarget } from "../../../shared/ui/overlay/popover";
import { Button } from "../../../shared/ui/primitives";
import { openCommandPalette } from "../../command-palette";
import { HerdSessionSwitch } from "../../herd-sessions/herd-session-row";
import { needsDaemonUpdate, subscribeDaemonUpdates } from "../../settings/daemon-update";
import type { HerdActions } from "../actions";
import type { HerdViewModel } from "../model/herd-view";
import { GroupModeButton } from "./herd-controls";
import { HostTitle } from "./host-title";

/**
 * The fixed frame of the desktop rail: the head above the list, the search
 * entry under it and the destinations below. The list scrolls between them.
 */

type RailCreateView = NonNullable<HerdViewModel["create"]>;

/**
 * Create, by the gesture that asks. A mouse click or the keyboard opens the
 * recent combinations as a menu under the button, the full sheet being its last
 * row (and what opens when there is nothing recent); a right-click or a held
 * button opens the same menu. A finger keeps the phone's pair: a tap opens the
 * create sheet, a hold offers the recent combinations.
 */
function RailCreate({ create, actions }: { create: RailCreateView; actions: HerdActions }) {
  const press = useObjectPress(() => actions.openQuickCreate(press.current), !create.disabled);
  return (
    <Button ref={press} className="rail-create" aria-haspopup="dialog" aria-label={create.aria} title={create.label}
      disabled={create.disabled} onClick={() => {
        // The overlay's own rule: a mouse or key open on a desk layout is anchored.
        if (popoverTarget("menu", press.current)) actions.openQuickCreate(press.current);
        else actions.createConversation();
      }}>
      <Plus size={18} aria-hidden="true" />
    </Button>
  );
}

/**
 * The phone header's parts for a column as narrow as 280px. The head is the
 * computer's: its title (it opens the computer panel, which also switches
 * computers) with the grouping button and create as icons, so the name and how
 * it is reached keep the width. The Herdr-session switch, while there is a
 * choice, is the row under it and names the session whose list this is.
 */
export function RailHead({ view, actions }: { view: HerdViewModel; actions: HerdActions }) {
  return (
    <>
      <header className="rail-head">
        <h1 className="sr-only">{t("tabs.sessions")}</h1>
        <HostTitle host={view.host} onOpen={actions.openHostMenu} brief />
        {view.groups.length ? <GroupModeButton mode={view.listGroup} onOpen={actions.openGroupModeMenu} iconOnly /> : null}
        {view.create ? <RailCreate create={view.create} actions={actions} /> : null}
      </header>
      <HerdSessionSwitch row />
    </>
  );
}

/**
 * A button that reads as a search field; search and jump open over the app.
 * `disabled` is the frame with no session behind it: nothing to search, and
 * no shortcut to advertise, because ⌘K opens nothing there either.
 */
export function RailSearch({ disabled = false }: { disabled?: boolean } = {}) {
  // The hint follows the keyboard: a tablet gains it with its first physical key.
  useHardwareKeyboard();
  const shortcut = !disabled && commandKOffered();
  return (
    <Button className="rail-search" aria-haspopup="dialog" aria-keyshortcuts={shortcut ? "Meta+K" : undefined}
      disabled={disabled} onClick={openCommandPalette}>
      <Search size={15} aria-hidden="true" />
      <span className="rail-search-text">{t("rail.search")}</span>
      {shortcut ? <kbd aria-hidden="true">⌘K</kbd> : null}
    </Button>
  );
}

function needsUpdate(): boolean {
  return needsDaemonUpdate();
}

/**
 * Board and Settings, the phone tab bar's other two destinations. Each is
 * marked current while it is the page beside the rail, and Settings carries the
 * tab bar's update dot. `disabled` locks both, as the tab bar does before a
 * session is live.
 */
export function RailFoot({ view, actions, disabled = false }: { view: HerdViewModel; actions: HerdActions; disabled?: boolean }) {
  const update = useSyncExternalStore(subscribeDaemonUpdates, needsUpdate);
  return (
    <nav className="rail-nav" aria-label={t("tabs.aria")}>
      <Button className={`rail-nav-item${view.board.current ? " is-current" : ""}`}
        aria-current={view.board.current ? "page" : undefined} disabled={disabled} onClick={actions.openBoard}>
        <LayoutDashboard size={16} aria-hidden="true" />
        <span>{view.board.label}</span>
      </Button>
      <Button className={`rail-nav-item${view.settings.current ? " is-current" : ""}`}
        aria-current={view.settings.current ? "page" : undefined} disabled={disabled} onClick={actions.openSettings}>
        <span className="rail-nav-icon">
          <Settings size={16} aria-hidden="true" />
          {update ? <span className="rail-nav-dot" aria-hidden="true" /> : null}
        </span>
        <span>{view.settings.label}</span>
        {update ? <span className="sr-only">{t("tabs.updateAria")}</span> : null}
      </Button>
    </nav>
  );
}
