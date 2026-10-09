import { MoreHorizontal, Plus } from "lucide-react";
import { t } from "../../../lib/i18n";
import { Button, Chevron } from "../../../shared/ui/primitives";
import { useObjectPress } from "../../../shared/ui/overlay";
import { contextOrigin, noteOverlayOrigin } from "../../../shared/ui/overlay/origin";
import type { HerdActions } from "../actions";
import type { HerdGroupView } from "../model/herd-view";
import { AgentCard } from "./agent-card";
import { indexedStyle } from "./indexed";

/**
 * One accordion section: a workspace or agent group, or the pinned group.
 *
 * The heading folds the section. A workspace heading also shows its root path,
 * the rows inside that need the reader (so a folded section still reports
 * them), a + that opens the create sheet on this workspace and a visible menu
 * button; the hold on the heading still opens the same menu.
 *
 * With `createInMenu` (the desktop rail under a finger) the + is left to the
 * menu, whose first row is the same create: two always-visible 44px tools and
 * two marks would leave the workspace two letters of its name.
 */
export function HerdGroup({
  group,
  groupIds,
  actions,
  hoverActions = false,
  createInMenu = false,
  createDisabled = false,
  listed = false,
}: {
  group: HerdGroupView;
  groupIds: string[];
  actions: HerdActions;
  /** Handed on to the rows; see `AgentCard`. */
  hoverActions?: boolean;
  createInMenu?: boolean;
  /** A session cannot be started right now (`HerdViewModel.creatable`): the + is drawn and does not answer. */
  createDisabled?: boolean;
  /** Handed on to the rows, and the body is the list that holds them; see `AgentCard`. */
  listed?: boolean;
}) {
  const press = useObjectPress(() => actions.openWorkspaceMenu(group.menuAgent), group.hasMenu);
  const marked = group.blockedCount > 0 || group.doneCount > 0;
  return (
    <section className="herd-group">
      {/* With a mouse the whole heading takes the right-click, not only its title; the title's own press handles it first.
          Wherever it landed (a mark, the path) the menu is the heading's: it still opens at the pointer, and the title is
          what it belongs to and where focus returns. */}
      <div className="group-head" style={indexedStyle(group.index)}
        onContextMenu={hoverActions && group.hasMenu ? (event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          noteOverlayOrigin({ ...contextOrigin(event.nativeEvent), target: press.current });
          actions.openWorkspaceMenu(group.menuAgent);
        } : undefined}>
        <Button
          ref={press}
          className="group-title"
          data-trigger-of={group.id}
          aria-expanded={!group.collapsed}
          aria-haspopup={group.hasMenu ? "menu" : undefined}
          onClick={() => actions.toggleGroup(group.id, groupIds)}
        >
          <Chevron className="group-chev" />
          <span className="group-name">{group.title}</span>
        </Button>
        <span className="group-marks">
          {group.blockedCount > 0 ? (
            <Button className="group-mark is-blocked"
              aria-label={t("list.markBlockedAria", { count: String(group.blockedCount) })}
              onClick={() => actions.revealAttention(group.id, "blocked")}>
              {t("list.markBlocked", { count: String(group.blockedCount) })}
            </Button>
          ) : null}
          {group.doneCount > 0 ? (
            <Button className="group-mark is-done"
              aria-label={t("list.markDoneAria", { count: String(group.doneCount) })}
              onClick={() => actions.revealAttention(group.id, "done")}>
              {t("list.markDone", { count: String(group.doneCount) })}
            </Button>
          ) : null}
          {!marked && group.count > 0 ? <span className="section-count">{group.count}</span> : null}
        </span>
        {group.canCreateTab && !createInMenu ? (
          <Button className="icon-btn group-tool" aria-label={t("list.newTabIn", { workspace: group.title })} disabled={createDisabled}
            data-trigger-of={`${group.id}:create`} onClick={() => actions.createInWorkspace(group.menuAgent)}>
            <Plus size={18} aria-hidden="true" />
          </Button>
        ) : null}
        {group.hasMenu ? (
          <Button className="icon-btn group-tool" aria-haspopup="menu" aria-label={t("list.workspaceMenu", { workspace: group.title })}
            data-trigger-of={group.id} onClick={() => actions.openWorkspaceMenu(group.menuAgent)}>
            <MoreHorizontal size={18} aria-hidden="true" />
          </Button>
        ) : null}
        {/* The inner span is what the rail hides when the heading's line leaves the path no room. */}
        {group.path ? <span className="group-path"><span>{group.path}</span></span> : null}
      </div>
      <div className="herd-group-body" hidden={group.collapsed} role={listed ? "list" : undefined} aria-label={listed ? group.title : undefined}>
        {group.cards.map((card) => (
          <AgentCard key={card.paneId} card={card} actions={actions} hoverActions={hoverActions} listed={listed} />
        ))}
      </div>
    </section>
  );
}
