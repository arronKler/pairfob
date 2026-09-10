import { Brand, Button, StatusDot } from "../../../shared/ui/primitives";
// AppNotice is the connected App notice (chrome barrel seam); HerdBanners is the
// connection feature's own pure banner component.
import { AppNotice } from "../../../app/notice";
import { HerdBanners } from "../../../features/connection/herd-banners";
import { CompletionCount } from "./herd-controls";
import type { HerdActions } from "../actions";
import type { HerdViewModel } from "../model/herd-view";
import { HerdList } from "./herd-list";

function HerdTopActions({ view, actions }: { view: HerdViewModel; actions: HerdActions }) {
  return (
    <div className="topbar-actions">
      {view.create && (
        <Button
          className="topbar-create"
          onClick={actions.createConversation}
          disabled={view.create.disabled}
          aria-label={view.create.aria}
        >
          {view.create.label}
        </Button>
      )}
      {view.computers && (
        <Button className="text-link" onClick={actions.openComputers}>{view.computers.label}</Button>
      )}
      <Button className="text-link" onClick={actions.openBoard}>{view.board.label}</Button>
      <Button className="text-link" onClick={actions.openSettings}>{view.settings.label}</Button>
    </div>
  );
}

/**
 * The herd surface: topbar, status line, banners and the list.
 *
 * `variant` is the only difference between the phone page and the desktop rail —
 * the rail deliberately shows no app notice, because the desktop main pane owns
 * notices for the open session.
 */
export function HerdScreen({
  view,
  actions,
  variant,
}: {
  view: HerdViewModel;
  actions: HerdActions;
  variant: "page" | "rail";
}) {
  const chrome = (
    <>
      <div className="topbar">
        <Brand tone={view.status.tone} heading />
        <HerdTopActions view={view} actions={actions} />
      </div>
      <p className="statusline">
        <StatusDot tone={view.status.tone} />
        <span className="statusline-text">{view.status.text}</span>
        <CompletionCount count={view.doneCount} />
      </p>
      <HerdBanners tone={view.status.tone} />
      {variant === "page" ? <AppNotice /> : null}
      <HerdList view={view} actions={actions} />
    </>
  );
  return variant === "rail" ? <aside className="rail">{chrome}</aside> : <div className="page">{chrome}</div>;
}
