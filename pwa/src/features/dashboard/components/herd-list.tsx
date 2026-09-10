import { Fragment } from "react";
import { EmptyState } from "../../../shared/ui/primitives";
import { WorktreeProgressList } from "../../operations/worktree-progress";
// Not this slice: the daemon update banner stays with its own owner.
import { DaemonUpdate } from "../../settings/daemon-update-view";
import { ListGroupControl } from "./herd-controls";
import type { HerdActions } from "../actions";
import type { HerdViewModel } from "../model/herd-view";
import { AgentCard } from "./agent-card";
import { HerdGroup } from "./herd-group";
import { indexedStyle } from "./indexed";

function emptySpec(view: HerdViewModel, actions: HerdActions) {
  const empty = view.empty;
  if (!empty) return null;
  const action = empty.action;
  return {
    title: empty.title,
    sub: empty.sub,
    figure: "panes" as const,
    action: action
      ? { label: action.label, disabled: action.disabled, run: () => actions.runEmptyAction(action.kind) }
      : undefined,
  };
}

/**
 * The herd list: daemon update, pending worktree jobs, the grouping control and
 * then either the empty state or the projected sections.
 */
export function HerdList({ view, actions }: { view: HerdViewModel; actions: HerdActions }) {
  const empty = emptySpec(view, actions);
  return (
    <>
      <DaemonUpdate compact />
      <WorktreeProgressList />
      <ListGroupControl />
      {empty ? (
        <EmptyState spec={empty} />
      ) : (
        <div className={`herd-list${view.stagger ? " enter" : ""}`}>
          {view.groups.map((group) =>
            view.grouped ? (
              <HerdGroup key={group.id} group={group} groupIds={view.groupIds} actions={actions} />
            ) : (
              <Fragment key={group.id}>
                <h2 className="section-title" style={indexedStyle(group.index)}>
                  {group.title}
                  {group.count > 0 && <span className="section-count">{group.count}</span>}
                </h2>
                {group.cards.map((card) => (
                  <AgentCard key={card.paneId} card={card} actions={actions} />
                ))}
              </Fragment>
            ),
          )}
        </div>
      )}
    </>
  );
}
