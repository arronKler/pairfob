import { MoreHorizontal } from "lucide-react";
import { useMemo } from "react";
import { t } from "../../lib/i18n";
import { AgentAvatar, Button } from "../../shared/ui/primitives";
import { favoriteKinds, type CreateMemory } from "./create-memory";

/** A kind's display name; "" is a plain terminal. */
export function kindName(kind: string): string {
  return kind || t("create.terminal");
}

/**
 * "What to start": four to a row, icon and name only — the favourite kinds
 * (pinned, then most used), a plain terminal and the way into the full list.
 * Shared by the home create sheet and the pane sheet's new-tab and split pages
 * so the choice looks and reads the same wherever a pane is created.
 */
export function AgentKindGrid({ kinds, memory, selected, onSelect, onShowAll }: {
  /** Advertised agent kinds; the only kinds offered. */
  kinds: readonly string[];
  memory: CreateMemory;
  selected: string;
  /** The preselected kind already shows the last choice; the grid no longer captions it. */
  lastKind?: string | null;
  onSelect: (kind: string) => void;
  onShowAll: () => void;
}) {
  const favorites = useMemo(() => favoriteKinds(kinds, memory, selected), [kinds, memory, selected]);
  return (
    <div className="create-kinds" role="radiogroup" aria-label={t("create.what")}>
      {favorites.map((item) => (
        <Button key={item} className={`create-kind${selected === item ? " on" : ""}`} role="radio" aria-checked={selected === item}
          onClick={() => onSelect(item)}>
          <AgentAvatar kind={item} />
          <span className="create-kind-name">{item}</span>
        </Button>
      ))}
      <Button className={`create-kind${selected === "" ? " on" : ""}`} role="radio" aria-checked={selected === ""} onClick={() => onSelect("")}>
        <AgentAvatar kind="" />
        <span className="create-kind-name">{t("create.terminal")}</span>
      </Button>
      {kinds.length > favorites.length ? (
        <Button className="create-kind is-all" aria-expanded={false} onClick={onShowAll}>
          <span className="agent-avatar is-md is-more" aria-hidden="true"><MoreHorizontal size={20} /></span>
          <span className="create-kind-name">{t("create.all", { n: String(kinds.length) })}</span>
        </Button>
      ) : null}
    </div>
  );
}
