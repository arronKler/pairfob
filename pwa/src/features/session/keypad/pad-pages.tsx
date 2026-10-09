import { useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { t } from "../../../lib/i18n";
import { PadChromeButton } from "../compose-focus";
import { clearModifiers } from "./keypad";
import { PAD_HOLD_EVENT } from "./key-press";
import { fitOneRow, type RowFit } from "./pad-fit";

/**
 * Where each pad kind was left, as the index of its page's first item. Hold it
 * above the pad body when keys and commands render different trees. An item
 * index rather than a page number, so a phone turned on its side (one row to a
 * page instead of two) stays on the keys it was showing.
 */
export type PageMemory = [Record<string, number>, Dispatch<SetStateAction<Record<string, number>>>];

/**
 * Fixed pages of two rows, or of one where the screen is short (`rows`). Keep
 * this component mounted to remember each mode's page.
 * The pagination row carries the pad's own chrome: `leading` on the left,
 * the dots in the middle and `trailing` on the right.
 * With one row to a page that chrome stands beside the row (see dock-dense.scss),
 * and the row holds as many of its `columns` as fit beside it at a key's width
 * (`pad-fit`): either side can be told the page's first item, since a page is then
 * not always the same keys. Where the row has no room for dots a finger can
 * aim at, the page is shown as a count that steps when pressed; swiping the
 * row turns pages either way.
 */
export function PadPages({ items, kind, label, columns = 4, rows = 2, className = "", leading, trailing, header, memory }: {
  items: ReactNode[]; kind: string; label: string; columns?: 4 | 7; rows?: 1 | 2; className?: string;
  leading?: ReactNode | ((page: number, firstItem: number) => ReactNode); trailing?: ReactNode | ((page: number, firstItem: number) => ReactNode); header?: ReactNode; memory?: PageMemory;
}) {
  const own = useState<Record<string, number>>({});
  const [positions, setPositions] = memory ?? own;
  const [fit, setFit] = useState<RowFit | null>(null);
  const shown = rows === 1 && fit ? fit.columns : columns;
  const pageSize = shown * rows;
  const count = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.floor((positions[kind] ?? 0) / pageSize), count - 1);
  const ref = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Measured after every commit: the switch is wider in English, and Edit mode
  // trades it for buttons of other widths. Set before paint, so no row is ever
  // drawn with keys it has no room for.
  const measure = useRef<() => void>(() => undefined);
  measure.current = () => {
    const row = wrap.current;
    if (rows !== 1 || !row) {
      if (fit) setFit(null);
      return;
    }
    const part = (selector: string): number => row.querySelector<HTMLElement>(selector)?.offsetWidth ?? 0;
    const view = row.ownerDocument.defaultView;
    const px = (element: Element | null, property: "columnGap"): number =>
      (element && Number.parseFloat(view?.getComputedStyle(element)[property] ?? "")) || 0;
    const next = fitOneRow({
      width: row.clientWidth, start: part(".pad-pagination-start"), end: part(".pad-pagination-end"),
      gap: px(row, "columnGap"), keyGap: px(ref.current, "columnGap"), items: items.length, columns,
    });
    if (next.columns !== fit?.columns || next.counted !== fit?.counted) setFit(next);
  };
  useLayoutEffect(() => { measure.current(); });
  useLayoutEffect(() => {
    const row = wrap.current;
    if (rows !== 1 || !row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(row);
    return () => observer.disconnect();
  }, [rows]);
  const suppressClick = useRef(false);
  const previous = useRef({ kind, page, rows });
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { kind, page, rows };
    const root = ref.current;
    // A turn of the phone renumbers the pages; nothing was turned by the reader.
    if (!root || before.kind !== kind || before.rows !== rows || before.page === page
      || root.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = root.animate?.([
      { opacity: 0.4, transform: `translateX(${page > before.page ? 20 : -20}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ], { duration: 180, easing: "ease-out" });
    return () => animation?.cancel();
  }, [kind, page, rows]);
  const selectRef = useRef<(next: number) => void>(() => undefined);
  selectRef.current = (next) => {
    const target = Math.max(0, Math.min(count - 1, next));
    if (target === page) return;
    clearModifiers();
    setPositions((old) => ({ ...old, [kind]: target * pageSize }));
  };
  useLayoutEffect(() => {
    const root = ref.current!;
    const doc = root.ownerDocument;
    let start: { id: number; x: number; y: number; holding: boolean } | null = null;
    const down = (event: PointerEvent) => {
      suppressClick.current = false;
      // A command being dragged in edit mode owns its gesture; it is not a page swipe.
      const dragging = event.target instanceof Element && event.target.closest("[data-pad-drag]");
      if (event.pointerType !== "touch" || !event.isPrimary || dragging) { start = null; return; }
      start = { id: event.pointerId, x: event.clientX, y: event.clientY, holding: false };
    };
    const move = (event: PointerEvent) => {
      if (!start || start.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
        suppressClick.current = true;
      }
    };
    const up = (event: PointerEvent) => {
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      // Once a hold has sent keys, its release must not also navigate.
      if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.4 && !start.holding) {
        suppressClick.current = true;
        selectRef.current(page + (dx < 0 ? 1 : -1));
      }
      start = null;
    };
    const hold = (event: Event) => {
      if (start?.id === (event as CustomEvent<number>).detail) start.holding = true;
    };
    const cancel = () => { start = null; suppressClick.current = true; };
    const visibility = () => { if (doc.hidden) cancel(); };
    const click = (event: MouseEvent) => {
      if (suppressClick.current && (event.detail !== 0 || ("pointerType" in event && event.pointerType))) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    doc.defaultView?.addEventListener("blur", cancel);
    doc.addEventListener("visibilitychange", visibility);
    root.addEventListener(PAD_HOLD_EVENT, hold);
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("click", click, true);
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", cancel, true);
    return () => {
      doc.defaultView?.removeEventListener("blur", cancel);
      doc.removeEventListener("visibilitychange", visibility);
      root.removeEventListener(PAD_HOLD_EVENT, hold);
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("click", click, true);
      doc.removeEventListener("pointermove", move, true);
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", cancel, true);
    };
  }, [page, kind]);
  const oneRow = rows === 1;
  // Dots too close for a finger are not drawn: the page is a count, and pressing it turns to the next one.
  const counted = oneRow && fit?.counted === true && count > 1;
  return <div ref={wrap} className={oneRow ? "pad-pages is-one-row" : "pad-pages"}
    style={oneRow ? { "--pad-cols": shown } as CSSProperties : undefined}>
    {header}
    <div ref={ref} className={`pad-page ${className}`} data-columns={columns} role="group" aria-label={label}>
      {items.slice(page * pageSize, (page + 1) * pageSize)}
    </div>
    <div className="pad-pagination">
      <div className="pad-pagination-start">{typeof leading === "function" ? leading(page, page * pageSize) : leading}</div>
      <div className="pad-dots" role="group" aria-label={t("keys.pages")}>
        {counted ? <PadChromeButton className="pad-page-count" type="button"
          aria-label={t("keys.pageStep", { page: page + 1, total: count })}
          onClick={() => selectRef.current(page + 1 < count ? page + 1 : 0)}
        ><b>{page + 1}</b> / {count}</PadChromeButton> : Array.from({ length: count }, (_, index) => <PadChromeButton
          key={index} className="pad-page-dot" type="button" data-pad-dot={index}
          aria-label={t("keys.page", { page: index + 1, total: count })}
          aria-current={index === page ? "page" : undefined}
          onClick={() => selectRef.current(index)}
        ><span /></PadChromeButton>)}
      </div>
      <div className="pad-pagination-end">{typeof trailing === "function" ? trailing(page, page * pageSize) : trailing}</div>
    </div>
  </div>;
}
