import { PanelsTopLeft, LayoutGrid, Unplug, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

/**
 * Empty placeholder for a list or canvas.
 *
 * The spec is a plain view model: copy, an optional icon and an
 * optional action. Callers resolve all of it, so the component holds no policy
 * about which screen is empty or why.
 */
export type EmptyFigure = "panes" | "grid" | "link" | "device";

export type EmptySpec = {
  title: string;
  sub: string;
  figure?: EmptyFigure;
  /** `icon` leads the label, for an action the app draws with one elsewhere (a create's "+"). */
  action?: { label: string; run: () => void; disabled?: boolean; icon?: ReactNode };
};

const EMPTY_FIGURES = { panes: PanelsTopLeft, grid: LayoutGrid, link: Unplug, device: Smartphone };

export function EmptyState({ spec }: { spec: EmptySpec }) {
  const Icon = spec.figure ? EMPTY_FIGURES[spec.figure] : null;
  return <div className="empty">
    {Icon && <div className={`empty-figure figure-${spec.figure}`} aria-hidden="true">
      <Icon size={44} strokeWidth={1.5} />
    </div>}
    <p className="empty-title">{spec.title}</p><p className="empty-sub">{spec.sub}</p>
    {spec.action && <Button className="btn btn-small btn-primary empty-action" disabled={spec.action.disabled === true}
      onClick={spec.action.run}>{spec.action.icon}{spec.action.label}</Button>}
  </div>;
}
