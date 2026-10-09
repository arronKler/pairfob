import { Check, MoreHorizontal, Pin, PinOff } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { t } from "../../../lib/i18n";
import { AgentAvatar, Button } from "../../../shared/ui/primitives";
import { useObjectPress } from "../../../shared/ui/overlay";
import type { HerdActions } from "../actions";
import type { HerdCardView } from "../model/herd-view";
import { indexedStyle } from "./indexed";
import { bindSwipeRow } from "./swipe-row";

/** Trailing actions a left swipe reveals: pin and the full menu. */
const TRAILING_WIDTH = 144;

/**
 * One session row.
 *
 * A tap opens the pane and the row grows into it (`app/transition` names the
 * row's avatar and title for that one navigation). A hold (or right-click)
 * opens the object menu. On a touch screen a left swipe reveals pin / more, and
 * a right swipe marks an unread completion as read; every swipe action is also
 * in the menu.
 *
 * With `hoverActions` (the desktop rail under a precise pointer) the same three
 * buttons are a cluster the style sheet shows on hover or focus: they follow
 * the row's button in the document, the keyboard reaches them with Right from
 * the row (`list-keys.ts`: the rail's list is one Tab stop), they are exposed
 * to assistive technology, and the row takes no swipe.
 *
 * Every row's menu controls look alike, so the two a menu can hang from (the
 * row itself and "more") say which session they are for (`data-trigger-of`,
 * `overlay/trigger.ts`): an open menu finds its own row again after the shell
 * redrew the list.
 */
export function AgentCard({ card, actions, hoverActions = false, listed = false }: {
  card: HerdCardView;
  actions: HerdActions;
  hoverActions?: boolean;
  /** The row is an item of a counted list (the rail, whose list is one keyboard stop: `list-keys.ts`). */
  listed?: boolean;
}) {
  const title = useRef<HTMLSpanElement>(null);
  const row = useRef<HTMLElement>(null);
  const press = useObjectPress(() => actions.openPaneMenu(card.agent));
  const unread = useRef(card.unread);
  unread.current = card.unread;
  const paneId = card.paneId;
  useLayoutEffect(() => {
    if (!row.current || hoverActions) return;
    return bindSwipeRow(row.current, {
      foreground: () => press.current,
      trailingWidth: TRAILING_WIDTH,
      canCommitRight: () => unread.current,
      onCommitRight: () => actions.markRead(paneId),
    });
  }, [actions, hoverActions, paneId, press]);
  const classes = [card.className, card.kind === "terminal" ? "is-terminal" : "",
    card.blocked ? "is-blocked" : "", card.unread ? "is-unread" : ""].filter(Boolean).join(" ");
  const pinLabel = card.pinned ? t("list.swipeUnpin") : t("list.swipePin");
  // Behind the sliding row the buttons are out of reach until a swipe uncovers
  // them, and the menu holds the same actions; as a hover cluster they are
  // icons, so each carries its name as a tooltip.
  const reach = (label: string) => hoverActions ? { title: label } : { tabIndex: -1 };
  const trailing = (
    <div className="card-actions" aria-hidden={hoverActions ? undefined : true}>
      {card.unread ? (
        <button type="button" {...reach(t("list.swipeRead"))} className="card-action is-read" onClick={() => actions.markRead(paneId)}>
          <Check size={18} aria-hidden="true" /><span className="card-action-label">{t("list.swipeRead")}</span>
        </button>
      ) : null}
      <button type="button" {...reach(pinLabel)} className="card-action is-pin" onClick={() => actions.togglePin(paneId)}>
        {card.pinned ? <PinOff size={18} aria-hidden="true" /> : <Pin size={18} aria-hidden="true" />}
        <span className="card-action-label">{pinLabel}</span>
      </button>
      <button type="button" {...reach(t("list.swipeMore"))} className="card-action is-more" data-trigger-of={paneId}
        aria-haspopup={hoverActions ? "menu" : undefined} onClick={() => actions.openPaneMenu(card.agent)}>
        <MoreHorizontal size={18} aria-hidden="true" /><span className="card-action-label">{t("list.swipeMore")}</span>
      </button>
    </div>
  );
  return (
    <article ref={row} className={classes} role={listed ? "listitem" : undefined} style={indexedStyle(card.index)}>
      {hoverActions ? null : trailing}
      <Button
        ref={press}
        className="card-main"
        data-pane-id={paneId}
        data-trigger-of={paneId}
        aria-pressed={card.selected}
        aria-haspopup="menu"
        onClick={() => actions.openPaneFromCard(paneId, title.current)}
      >
        <AgentAvatar kind={card.kind === "agent" ? card.agentKind : ""}
          status={card.kind === "agent" ? card.statusTone : undefined} />
        <span className="card-copy">
          <span className="card-title" ref={title}>
            {card.pinned ? <>
              <Pin className="pin-mark" size={12} aria-hidden="true" />
              <span className="sr-only">{card.pinnedLabel}</span>
            </> : null}
            <span className="card-name">{card.title}</span>
          </span>
          <span className="card-meta">
            {card.statusLabel ? <span className={`card-status is-${card.statusTone}`}>{card.statusLabel}</span> : null}
            {card.statusLabel && card.line ? <span aria-hidden="true"> · </span> : null}
            {card.line}
          </span>
        </span>
        <span className="card-side">
          {card.ago ? <span className="card-ago">{card.ago}</span> : null}
          {card.blocked || card.unread ? <span className={`card-dot${card.blocked ? " is-blocked" : ""}`} aria-hidden="true" /> : null}
        </span>
      </Button>
      {hoverActions ? trailing : null}
    </article>
  );
}
