import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { Button } from "../../../shared/ui/primitives";
import { prefersReducedMotion } from "../../../shared/ui/dom/motion";
import { rememberedScroll, useRememberedScroll } from "../../../shared/ui/dom/remembered-scroll";
import { preferencesStore, setListGroupCollapsed } from "../../settings/preferences-store";
// AppNotice is the connected App notice (chrome barrel seam); HerdBanners is the
// connection feature's own pure banner component.
import { AppNotice } from "../../../app/notice";
import { HerdBanners } from "../../../features/connection/herd-banners";
import { HerdSessionSwitch } from "../../herd-sessions/herd-session-row";
import { CreateFab, GroupModeButton } from "./herd-controls";
import type { HerdActions } from "../actions";
import type { HerdViewModel } from "../model/herd-view";
import { AttentionStrip } from "./attention-strip";
import { HerdList } from "./herd-list";
import { HostTitle } from "./host-title";
import { useListKeys } from "./list-keys";
import { RailFoot, RailHead, RailSearch } from "./rail-chrome";
import { useRegridFocus } from "./regrid-focus";
import { closeOpenSwipeRow, closeSwipeRowOutside } from "./swipe-row";

/**
 * The phone header folds past FOLD_PX and unfolds only back near the top. The
 * gap is wider than the height the fold removes, so the layout shift of a fold
 * can never scroll the page back across the other threshold (no flicker).
 */
const FOLD_PX = 120;
const UNFOLD_PX = 12;

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
 * outside it reaches Board and Settings. The desktop rail is the same parts in a
 * fixed frame: the header's controls and create in its head, search, the strip,
 * then the list scrolling above Board and Settings. It deliberately shows no app
 * notice because the desk main pane owns notices for the open session.
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
  const lastLocated = useRef({ blocked: "", done: "", any: "" });
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
  // "any" walks the strip's own order: rows waiting on the reader, then unread completions.
  const revealNext = (status: "blocked" | "done" | "any", groupId?: string) => {
    const rows = view.groups
      .filter(group => !groupId || group.id === groupId)
      .flatMap(group => group.cards.map(card => ({ paneId: card.paneId, groupId: group.id, blocked: card.blocked, unread: card.unread })));
    const candidates = status === "any"
      ? view.attention.flatMap(item => rows.filter(row => row.paneId === item.paneId))
      : rows.filter(row => status === "blocked" ? row.blocked : row.unread);
    if (!candidates.length) return;
    const previous = candidates.findIndex(card => card.paneId === lastLocated.current[status]);
    const next = candidates[(previous + 1) % candidates.length];
    lastLocated.current[status] = next.paneId;
    reveal(next.paneId, next.groupId);
  };
  // One identity for the life of the screen: a row binds its swipe to these
  // actions, and a new object on every commit would rebind it and shut a row
  // the reader has swiped open.
  const latestReveal = useRef(revealNext);
  latestReveal.current = revealNext;
  const screenActions = useMemo<HerdActions>(
    () => ({ ...actions, revealAttention: (groupId, kind) => latestReveal.current(kind, groupId) }),
    [actions],
  );
  const bindRoot = (node: HTMLElement | null) => { root.current = node; };
  useRegridFocus(root, variant);
  useListKeys(root, variant);
  // What the column beside the rail shows. However it moved on (a ticket, the
  // empty column's card, search and jump, Board), a row left swiped open belongs
  // to the moment before. The phone page leaves with its rows instead.
  const beside = variant === "rail"
    ? `${view.groups.flatMap(group => group.cards).find(card => card.selected)?.paneId ?? ""}|${view.board.current}|${view.settings.current}`
    : "";
  useEffect(() => { closeOpenSwipeRow(); }, [beside]);
  // Beside the rail the reader goes on working with the row still slid open:
  // the session it sits next to, the rail's own chrome, the inspector. A press
  // on any of them puts the row back, and is left to do what it was for. The
  // phone page has only its list under the finger, and keeps closing by row.
  useEffect(() => {
    if (variant !== "rail") return;
    const pressed = (event: PointerEvent) => closeSwipeRowOutside(event.target);
    document.addEventListener("pointerdown", pressed, { capture: true, passive: true });
    return () => document.removeEventListener("pointerdown", pressed, { capture: true });
  }, [variant]);

  const explained = view.empty?.kind === "exited" || view.empty?.kind === "unverifiable";
  if (variant === "rail") {
    return (
      <aside ref={bindRoot} className="rail">
        <RailHead view={view} actions={actions} />
        <RailSearch />
        <AttentionStrip items={view.attention} onOpen={actions.openAttention} onLocate={() => revealNext("any")} wheel />
        {/* As on the page: an empty list already says Herdr is gone or silent, here and in the column beside it. */}
        {explained ? null : <HerdBanners tone={view.status.tone} />}
        <div className="rail-list">
          <HerdList view={view} actions={screenActions} variant="rail" />
        </div>
        <RailFoot view={view} actions={actions} />
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
          <HerdSessionSwitch />
          {view.groups.length ? <GroupModeButton mode={view.listGroup} onOpen={actions.openGroupModeMenu} /> : null}
        </div>
        <AttentionStrip items={view.attention} onOpen={actions.openAttention} hidden={folded} />
      </header>
      {/* An empty list's panel already explains Herdr being gone or silent. */}
      {explained ? null : <HerdBanners tone={view.status.tone} />}
      <AppNotice />
      <HerdList view={view} actions={screenActions} variant="page" />
      {/* Empty or still reading: the list area owns the one create action (or none). */}
      {view.create && view.groups.length ? <CreateFab create={view.create} onCreate={actions.openCreate} onQuick={() => actions.openQuickCreate()} /> : null}
    </div>
  );
}
