import { useRef } from "react";
import { Button, Chevron } from "../../../shared/ui/primitives";
import { useObjectPress } from "../../../shared/ui/overlay";
import type { HerdActions } from "../actions";
import type { HerdCardView } from "../model/herd-view";
import { indexedStyle } from "./indexed";

/**
 * One session card.
 *
 * A single control: click opens the pane, a hold opens the object menu. The
 * menu action receives the card projected by the last paint and re-checks the
 * busy/connection guard when the press actually lands.
 */
export function AgentCard({ card, actions }: { card: HerdCardView; actions: HerdActions }) {
  const title = useRef<HTMLDivElement>(null);
  const press = useObjectPress(() => actions.openPaneMenu(card.agent));
  return (
    <article className={card.className} style={indexedStyle(card.index)}>
      <Button
        ref={press}
        className="card-main"
        aria-pressed={card.selected}
        aria-haspopup="menu"
        onClick={() => actions.openPaneFromCard(card.paneId, title.current)}
      >
        <div className="card-copy">
          <div
            className="card-title"
            ref={title}
            style={card.sharesTransition ? { viewTransitionName: "pane-title" } : undefined}
          >
            {card.pinned && (
              <>
                <span className="pin-mark" aria-hidden="true" />
                <span className="sr-only">{card.pinnedLabel}</span>
              </>
            )}
            <span className="card-name">{card.title}</span>
            {card.pill && <span className={card.pill.className}>{card.pill.text}</span>}
          </div>
          {card.meta && <p className="card-meta">{card.meta}</p>}
        </div>
        <Chevron />
      </Button>
    </article>
  );
}
