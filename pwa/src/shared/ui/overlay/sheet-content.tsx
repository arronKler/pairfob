import { ChevronLeft, X } from "lucide-react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../lib/i18n";
import { Button } from "../primitives/button";
import { DeskFormContext, useDeskForm } from "./desk-form";
import { DeskClose } from "./modal";

export function SheetHandle() {
  return <div className="sheet-grab" aria-hidden="true"><span className="sheet-grab-bar" /></div>;
}

/** An expandable sheet's handle is also a tap target for the taller height. */
function ExpandHandle({ expanded, toggle }: { expanded: boolean; toggle: () => void }) {
  return <Button className="sheet-grab" aria-expanded={expanded} aria-label={t(expanded ? "sheet.collapse" : "sheet.expand")}
    onClick={toggle}><span className="sheet-grab-bar" aria-hidden="true" /></Button>;
}

/**
 * Mark a scroller with what lies beyond its edges: `data-above` once content
 * has scrolled under the head, `data-below` while more waits under the footer.
 * The desk card rules its head and its pinned footer off only then, so a form
 * that fits is one plain surface like every other desk dialog.
 */
function useScrollEdges(active: boolean): (node: HTMLElement | null) => void {
  const scroller = useRef<HTMLElement | null>(null);
  const mark = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    node.toggleAttribute("data-above", node.scrollTop > 0);
    node.toggleAttribute("data-below", node.scrollTop + node.clientHeight < node.scrollHeight - 1);
  }, []);
  // Content changes height without a scroll (a page is pushed, a list loads).
  useLayoutEffect(() => { if (active) mark(); });
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!active || !node) return;
    node.addEventListener("scroll", mark, { passive: true });
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
    sized?.observe(node);
    return () => {
      node.removeEventListener("scroll", mark);
      sized?.disconnect();
      node.removeAttribute("data-above");
      node.removeAttribute("data-below");
    };
  }, [active, mark]);
  return useCallback((node: HTMLElement | null) => { scroller.current = node; }, []);
}

/** The desk card's footer slot, written after its scrolling body; null in a bottom sheet. */
const SheetFootContext = createContext<HTMLElement | null>(null);

/**
 * The actions under a sheet's form, with what will happen said above them.
 *
 * In the bottom sheet they are pinned inside the scroller, where the thumb is
 * and above the on-screen keyboard. The desk card writes them after its
 * scrolling body instead: the scroller is only what lies between the head and
 * the footer, so a scrollbar never passes beside the actions or moves them, and
 * they sit where every other desk dialog has them whether or not the form
 * scrolls. The order a Tab walks is unchanged: the form, the footer, the close.
 */
export function SheetFooter({ children }: { children: ReactNode }) {
  const foot = useContext(SheetFootContext);
  return foot ? createPortal(children, foot) : children;
}

function assign<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * The common sheet header, close target and scrollable body, without another wrapper.
 *
 * In the desk form (`desk`; a dialog that opened for a mouse or the keyboard
 * beside the list, anchored or centred) the close control leaves the head and
 * is written last, in the card's corner, as in every other desk dialog: Tab
 * walks the page's way back, the form and its footer first. The card also has
 * a place for that footer under the scrolling body (`SheetFooter`). The sheet
 * keeps its head as it is.
 */
export function SheetContent({ title, titleId, subtitle, onDismiss, onBack, backLabel, expand, bodyRef, bodyRole, desk, children }: {
  title: string; titleId: string; subtitle?: string; onDismiss: () => void; bodyRef: Ref<HTMLDivElement>; children: ReactNode;
  /** `menu` when the body is a popover's command list; the title names it. */
  bodyRole?: "menu";
  /** Present while a pushed page is showing. */
  onBack?: () => void;
  /** The page Back returns to, named next to the chevron. */
  backLabel?: string;
  expand?: { expanded: boolean; toggle: () => void };
  /** The desk form's anatomy. Left out, the dialog's own opening gesture and width decide. */
  desk?: boolean;
}) {
  const own = useDeskForm();
  const card = desk ?? own;
  const edges = useScrollEdges(card);
  const body = useCallback((node: HTMLDivElement | null) => { edges(node); assign(bodyRef, node); }, [edges, bodyRef]);
  const form = useMemo(() => card ? { cancel: onBack ?? onDismiss } : null, [card, onBack, onDismiss]);
  const [foot, setFoot] = useState<HTMLDivElement | null>(null);

  return <DeskFormContext value={form}>
    {expand ? <ExpandHandle {...expand} /> : <SheetHandle />}
    <div className={`sheet-head${onBack ? " has-back" : ""}`}>
      {onBack && <Button className={`icon-btn sheet-back${backLabel ? " has-label" : ""}`} aria-label={t("sheet.back")} onClick={onBack}>
        <ChevronLeft size={22} aria-hidden="true" />{backLabel && <span className="sheet-back-label" aria-hidden="true">{backLabel}</span>}</Button>}
      {subtitle ? <div className="sheet-titles"><h2 id={titleId} className="modal-title">{title}</h2>
        <p className="sheet-subtitle">{subtitle}</p></div>
        : <h2 id={titleId} className="modal-title">{title}</h2>}
      {card ? null : <Button className="icon-btn sheet-close" aria-label={t("close")} onClick={onDismiss}><X size={20} aria-hidden="true" /></Button>}
    </div>
    <div ref={body} className="sheet-body" role={bodyRole} aria-labelledby={bodyRole ? titleId : undefined}>
      <SheetFootContext value={card ? foot : null}>{children}</SheetFootContext>
    </div>
    {card ? <div ref={setFoot} className="sheet-foot" /> : null}
    {card ? <DeskClose onDismiss={onDismiss} /> : null}
  </DeskFormContext>;
}
