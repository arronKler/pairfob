import { CircleAlert, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { Brand, Button, StatusDot, TopbarActions } from "../../../shared/ui/primitives";
import { prefersReducedMotion } from "../../../shared/ui/dom/motion";
import { rememberedScroll, useRememberedScroll } from "../../../shared/ui/dom/remembered-scroll";
import { preferencesStore, setListGroupCollapsed } from "../../settings/preferences-store";
// AppNotice is the connected App notice (chrome barrel seam); HerdBanners is the
// connection feature's own pure banner component.
import { AppNotice } from "../../../app/notice";
import { HerdBanners } from "../../../features/connection/herd-banners";
import { CompletionCount, CreateFab, GroupModeButton } from "./herd-controls";
import type { HerdActions } from "../actions";
import type { HerdViewModel } from "../model/herd-view";
import { AttentionStrip } from "./attention-strip";
import { HerdList } from "./herd-list";
import { HostTitle } from "./host-title";
import { closeOpenSwipeRow } from "./swipe-row";

/**
 * The phone header folds past FOLD_PX and unfolds only back near the top. The
 * gap is wider than the height the fold removes, so the layout shift of a fold
 * can never scroll the page back across the other threshold (no flicker).
 */
const FOLD_PX = 120;
const UNFOLD_PX = 12;

function RailCreate({ view, actions }: { view: HerdViewModel; actions: HerdActions }) {
  if (!view.create) return null;
  return (
    <TopbarActions className="herd-topbar-actions">
      <Button
        className="topbar-create"
        onClick={actions.createConversation}
        disabled={view.create.disabled}
        aria-label={view.create.aria}
      >
        <Plus size={16} aria-hidden="true" />{view.create.label}
      </Button>
    </TopbarActions>
  );
}

/** The rail's destinations on one row of their own, so none wraps under the brand. */
function RailNav({ view, actions }: { view: HerdViewModel; actions: HerdActions }) {
  return (
    <nav className="rail-nav" aria-label={t("tabs.aria")}>
      {view.computers && (
        <Button className="text-link" onClick={actions.openComputers}>{view.computers.label}</Button>
      )}
      <Button className="text-link" onClick={actions.openBoard}>{view.board.label}</Button>
      <Button className="text-link" onClick={actions.openSettings}>{view.settings.label}</Button>
    </nav>
  );
}

/** Reveal a row the reader asked for: open its group, then scroll it into view. */
function useReveal(view: HerdViewModel, root: React.RefObject<HTMLElement | null>) {
  const [request, setRequest] = useState(0);
  const target = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!target.current) return;
    if (!view.groups.some(group => !group.collapsed && group.cards.some(card => card.paneId === target.current))) return;
    const node = [...(root.current?.querySelectorAll<HTMLElement>(".card-main[data-pane-id]") ?? [])]
      .find(item => item.dataset.paneId === target.current);
    if (!node) return;
    target.current = null;
    node.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    node.focus({ preventScroll: true });
  }, [request, view, root]);
  return (paneId: string, groupId: string) => {
    target.current = paneId;
    setListGroupCollapsed({ ...preferencesStore.get().listGroupCollapsed, [groupId]: false });
    setRequest(value => value + 1);
  };
}

/** Minute ticks keep the "changed n ago" column honest while the list is open. */
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
}

/**
 * The herd surface.
 *
 * The phone page is the option B header (computer title, grouping button, the
 * "needs you" strip), the list and the floating create button; the tab bar
 * outside it reaches Board and Settings. The desktop rail keeps its compact top
 * bar and status line, and deliberately shows no app notice because the desk
 * main pane owns notices for the open session.
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
  const root = useRef<HTMLElement>(null);
  const reveal = useReveal(view, root);
  const lastLocated = useRef({ blocked: "", done: "" });
  // A page returning past the fold renders folded from the start: folding after
  // the offset is restored would shrink the header above it and scroll
  // anchoring would pull the list up by the difference.
  const [folded, setFolded] = useState(() => variant === "page" && rememberedScroll("herd") > FOLD_PX);
  const head = useRef<HTMLElement>(null);
  useMinuteTick();
  // The list keeps its place across tab switches and a trip into a session.
  useRememberedScroll("herd", variant === "page");
  useEffect(() => {
    if (variant !== "page") return;
    let frame = 0;
    const onScroll = () => {
      closeOpenSwipeRow();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        setFolded((current) => current ? y > UNFOLD_PX : y > FOLD_PX);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [variant]);
  // Section headings stick right under the header, whatever its current height.
  // The height lives on the root, whose scroll padding keeps a focused row out
  // from under the sticky header. The fractional box height is used: offsetHeight
  // rounds, and a header at e.g. 97.6px would leave a hairline gap on the phone.
  useLayoutEffect(() => {
    const node = head.current;
    if (variant !== "page" || !node) return;
    const rootStyle = document.documentElement.style;
    const apply = () => rootStyle.setProperty("--herd-head-h", `${node.getBoundingClientRect().height}px`);
    apply();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(node, { box: "border-box" });
    return () => {
      observer?.disconnect();
      rootStyle.removeProperty("--herd-head-h");
    };
  }, [variant]);
  const revealNext = (status: "blocked" | "done", groupId?: string) => {
    const candidates = view.groups
      .filter(group => !groupId || group.id === groupId)
      .flatMap(group => group.cards
        .filter(card => status === "blocked" ? card.blocked : card.unread)
        .map(card => ({ paneId: card.paneId, groupId: group.id })));
    if (!candidates.length) return;
    const previous = candidates.findIndex(card => card.paneId === lastLocated.current[status]);
    const next = candidates[(previous + 1) % candidates.length];
    lastLocated.current[status] = next.paneId;
    reveal(next.paneId, next.groupId);
  };
  const screenActions: HerdActions = { ...actions, revealAttention: (groupId, kind) => revealNext(kind, groupId) };
  const bindRoot = (node: HTMLElement | null) => { root.current = node; };

  if (variant === "rail") {
    return (
      <aside ref={bindRoot} className="rail">
        <div className="topbar herd-topbar">
          <Brand tone={view.status.tone} heading />
          <RailCreate view={view} actions={actions} />
        </div>
        <RailNav view={view} actions={actions} />
        <p className="statusline">
          <StatusDot tone={view.status.tone} />
          <span className="statusline-text">{view.status.text}</span>
          <span className="attention-counts">
            {view.pendingCount > 0 && <Button className="text-link pending-count"
              aria-label={t("home.pendingCountAria", { count: String(view.pendingCount) })} onClick={() => revealNext("blocked")}>
              <CircleAlert size={14} aria-hidden="true" />{t("home.pendingCount", { count: String(view.pendingCount) })}
            </Button>}
            <CompletionCount count={view.doneCount} onActivate={() => revealNext("done")} />
          </span>
        </p>
        <HerdBanners tone={view.status.tone} />
        <HerdList view={view} actions={screenActions} variant="rail" />
      </aside>
    );
  }

  return (
    <div ref={bindRoot} className="page herd-page">
      <h1 className="sr-only">{t("tabs.sessions")}</h1>
      <header ref={head} className={`herd-head${folded ? " is-folded" : ""}`}>
        <div className="herd-head-row">
          <HostTitle host={view.host} onOpen={actions.openHostMenu} />
          {view.attention.length ? (
            // Mounted while there is attention so it can fade in as the header
            // folds; unfolded, the strip below carries the same shortcut.
            <Button className="herd-attn-pill" tabIndex={folded ? undefined : -1} aria-hidden={folded ? undefined : true}
              onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" })}>
              {t("list.needsYou", { count: String(view.attention.length) })}
            </Button>
          ) : null}
          {view.groups.length ? <GroupModeButton mode={view.listGroup} onOpen={actions.openGroupModeMenu} /> : null}
        </div>
        <AttentionStrip items={view.attention} onOpen={actions.openAttention} hidden={folded} />
      </header>
      {/* An empty list's panel already explains Herdr being gone or silent. */}
      {view.empty?.kind === "exited" || view.empty?.kind === "unverifiable" ? null : <HerdBanners tone={view.status.tone} />}
      <AppNotice />
      <HerdList view={view} actions={screenActions} variant="page" />
      {/* Empty or still reading: the list area owns the one create action (or none). */}
      {view.create && view.groups.length ? <CreateFab create={view.create} onCreate={actions.openCreate} onQuick={actions.openQuickCreate} /> : null}
    </div>
  );
}
