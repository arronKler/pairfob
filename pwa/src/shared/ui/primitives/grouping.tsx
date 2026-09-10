import { Button } from "./button";
import { Chevron } from "./navigation";

export function SectionTitle({ text, count }: { text: string; count?: number }) {
  return <h2 className="section-title">{text}{count !== undefined && count > 0 && <span className="section-count">{count}</span>}</h2>;
}

/** Collapsible list-group header. Expansion state and the toggle stay with the caller. */
export function GroupToggle({ title, count, expanded, onToggle }: {
  title: string; count: number; expanded: boolean; onToggle: () => void;
}) {
  return <Button className="group-title" aria-expanded={expanded} onClick={onToggle}>
    <Chevron className="group-chev" /><span className="group-name">{title}</span>
    {count > 0 && <span className="section-count">{count}</span>}
  </Button>;
}
