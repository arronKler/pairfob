import { Bot, Folder, List, ListTree, Plus } from "lucide-react";
import { useObjectPress } from "../../../shared/ui/overlay";
import { batch } from "../../../shared/model/domain-store";
import { dashboardStore } from "../catalog-store";
import { listGroup, preferencesStore, setListGroup, setListGroupCollapsed } from "../../settings/preferences-store";
import { groupAgents, syncGroupCollapsed, type ListGroup } from "../../../lib/ranking";
import { t } from "../../../lib/i18n";
// Temporary shared-UI paths: the primitives are the approved shared surface.
import { Button } from "../../../shared/ui/primitives";

/**
 * Herd header controls: the grouping choice, the button that names it and the
 * floating create button. The choice is a typed preferences action, so a
 * subscribed list updates on its publication instead of asking the application
 * for a repaint.
 */

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
            preferencesStore.get().paneActivated,
            preferencesStore.get().panePinned,
          ),
          {},
        );
  batch(() => {
    setListGroup(id);
    setListGroupCollapsed(collapsed);
  });
}

/**
 * Header control naming the current grouping; it opens the grouping sheet. The
 * desktop rail has room for the icon only, so there the name is a tooltip.
 */
export function GroupModeButton({ mode, onOpen, iconOnly = false }: { mode: ListGroup; onOpen: () => void; iconOnly?: boolean }) {
  const label = t(mode === "space" ? "list.modeSpace" : mode === "agent" ? "list.modeAgent" : "list.modeFlat");
  const name = t("list.modeAria", { mode: label });
  // Beside the session header the folder already means "files", so the rail's icon-only button draws the grouping instead.
  const Icon = mode === "space" ? (iconOnly ? ListTree : Folder) : mode === "agent" ? Bot : List;
  return (
    <Button className="herd-mode" aria-haspopup="dialog" aria-label={name} title={iconOnly ? name : undefined} onClick={onOpen}>
      <Icon size={16} aria-hidden="true" />
      {iconOnly ? null : <span>{label}</span>}
    </Button>
  );
}

/**
 * The floating create button. A tap opens the create sheet; a hold offers the
 * recent agent + workspace combinations to start again in one step.
 */
export function CreateFab({ create, onCreate, onQuick }: {
  create: { label: string; aria: string; disabled: boolean };
  onCreate: () => void;
  onQuick: () => void;
}) {
  const press = useObjectPress(onQuick, !create.disabled);
  return (
    <Button ref={press} className="create-fab" aria-label={create.aria} disabled={create.disabled} onClick={onCreate}>
      <Plus size={20} aria-hidden="true" />
      <span className="create-fab-label">{create.label}</span>
    </Button>
  );
}
