import { useSyncExternalStore } from "react";
import { batch } from "../../../shared/model/domain-store";
import { dashboardStore } from "../catalog-store";
import { listGroup, preferencesStore, setListGroup, setListGroupCollapsed } from "../../settings/preferences-store";
import { groupAgents, syncGroupCollapsed, type ListGroup } from "../../../lib/ranking";
import { t } from "../../../lib/i18n";
// Temporary shared-UI paths: the primitives are the approved shared surface.
import { Button } from "../../../shared/ui/primitives";
import { prefersReducedMotion } from "../../../shared/ui/dom/motion";

/**
 * Connected herd controls.
 *
 * These two were the application-connected part of the old chrome module: they
 * belong to the dashboard, so they live with it. Each subscribes to the domain it
 * reads, which is what lets them sit in any host — the herd list, which already
 * subscribes, or the settings screen, which does not — and update on their own
 * publication instead of asking the application for a repaint.
 */

const GROUP_OPTIONS = [
  { id: "flat", key: "list.flat" },
  { id: "space", key: "list.space" },
  { id: "agent", key: "list.agent" },
] as const;

/**
 * A new grouping starts from the default accordion: no previous fold carries
 * over. The defaults are prepared here, as part of the typed choice, so a
 * subscribed list does not wait for a later presentHerdView pass.
 */
export function chooseListGroup(id: ListGroup): void {
  if (listGroup() === id) return;
  const collapsed =
    id === "flat"
      ? {}
      : syncGroupCollapsed(
          groupAgents(
            [...dashboardStore.get().agents],
            id,
            preferencesStore.get().paneTouched,
            preferencesStore.get().panePinned,
          ),
          {},
        );
  batch(() => {
    setListGroup(id);
    setListGroupCollapsed(collapsed);
  });
}

export function ListGroupControl() {
  const group = useSyncExternalStore(preferencesStore.subscribe, listGroup);
  return (
    <div className="seg" role="radiogroup" aria-label={t("list.groupAria")}>
      {GROUP_OPTIONS.map((option) => (
        <Button
          key={option.id}
          role="radio"
          aria-checked={group === option.id}
          className={`seg-item${group === option.id ? " on" : ""}`}
          onClick={() => chooseListGroup(option.id)}
        >
          {t(option.key)}
        </Button>
      ))}
    </div>
  );
}

/** How many cards still wait to be read; tapping scrolls to the first one. */
export function CompletionCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Button
      className="text-link done-count"
      aria-label={t("home.doneCountAria", { count: String(count) })}
      onClick={() =>
        document.querySelector(".card.status-done")?.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "center",
        })
      }
    >
      {t("home.doneCount", { count: String(count) })}
    </Button>
  );
}
