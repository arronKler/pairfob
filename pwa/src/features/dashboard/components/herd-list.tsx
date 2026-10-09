import { WorktreeProgressList } from "../../operations/worktree-progress";
// Not this slice: the daemon update banner stays with its own owner. The phone
// shows it in Settings; the desktop rail keeps the compact notice.
import { DaemonUpdate } from "../../settings/daemon-update-view";
import type { HerdActions } from "../actions";
import type { HerdViewModel } from "../model/herd-view";
import { AgentCard } from "./agent-card";
import { HerdGroup } from "./herd-group";
import { HerdSkeleton } from "./herd-skeleton";
import { HerdEmpty } from "./herd-empty";
import { indexedStyle } from "./indexed";
import { usePointerFine } from "./use-pointer-fine";

/**
 * The herd list: pending worktree jobs, then either the empty state or the
 * projected sections. The desktop rail also carries the compact daemon update,
 * which the phone shows in Settings. Under a precise pointer the rail's rows
 * offer their actions on hover instead of behind a swipe.
 */
export function HerdList({ view, actions, variant = "page" }: {
  view: HerdViewModel;
  actions: HerdActions;
  variant?: "page" | "rail";
}) {
  const groups = view.groups;
  const hoverActions = usePointerFine() && variant === "rail";
  // The rail's rows are items of a list a screen reader counts; the phone page keeps the markup it has.
  const listed = variant === "rail";
  return (
    <>
      {variant === "rail" ? <DaemonUpdate compact /> : null}
      <WorktreeProgressList />
      {view.loading ? <HerdSkeleton /> : view.empty ? <HerdEmpty empty={view.empty} actions={actions} beside={variant === "rail"} /> : (
        <div className={`herd-list${view.stagger ? " enter" : ""}`}>
          {groups.map((group) => view.grouped ? (
            <HerdGroup key={group.id} group={group} groupIds={groups.map((item) => item.id)} actions={actions}
              hoverActions={hoverActions} createInMenu={variant === "rail" && !hoverActions} createDisabled={!view.creatable} listed={listed} />
          ) : (
            <section key={group.id} className="herd-group">
              <h2 className="section-title" style={indexedStyle(group.index)}>
                <span className="herd-section-name">{group.title}</span>
                {group.count > 0 && <span className="section-count">{group.count}</span>}
              </h2>
              <div className="herd-group-body" role={listed ? "list" : undefined} aria-label={listed ? group.title : undefined}>
                {group.cards.map((card) => (
                  <AgentCard key={card.paneId} card={card} actions={actions} hoverActions={hoverActions} listed={listed} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
