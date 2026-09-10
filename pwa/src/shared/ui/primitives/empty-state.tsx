import { Button } from "./button";

/**
 * Empty placeholder for a list or canvas.
 *
 * The spec is a plain view model: copy, an optional geometric figure and an
 * optional action. Callers resolve all of it, so the component holds no policy
 * about which screen is empty or why.
 */
export type EmptyFigure = "panes" | "grid" | "link" | "device";

export type EmptySpec = {
  title: string;
  sub: string;
  figure?: EmptyFigure;
  action?: { label: string; run: () => void; disabled?: boolean };
};

const EMPTY_FIGURE_BLOCKS = { panes: 3, grid: 4, link: 3, device: 2 };

export function EmptyState({ spec }: { spec: EmptySpec }) {
  return <div className="empty">
    {spec.figure && <div className={`empty-figure figure-${spec.figure}`} aria-hidden="true">
      {Array.from({ length: EMPTY_FIGURE_BLOCKS[spec.figure] }, (_, i) => <span key={i} />)}
    </div>}
    <p className="empty-title">{spec.title}</p><p className="empty-sub">{spec.sub}</p>
    {spec.action && <Button className="btn btn-small btn-primary empty-action" disabled={spec.action.disabled === true}
      onClick={spec.action.run}>{spec.action.label}</Button>}
  </div>;
}
