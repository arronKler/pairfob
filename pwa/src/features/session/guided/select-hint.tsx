import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../../../lib/i18n";
import { Button } from "../../../shared/ui/primitives";
import { toggleTermSelect } from "./term";

/**
 * The selection-mode hint: what the mode is, and the way out of it.
 *
 * It floats over the buffer so that entering selection moves no line, which
 * means it covers a few rows at the end it sits at. It sits at the top unless
 * the selection is there: a row picked near the top of the screen is the very
 * thing the reader is looking at, and its handles and the system's copy menu
 * need that space too. Then it takes the bottom, and comes back if the
 * selection moves down there.
 *
 * A short landscape screen has no end to spare: the buffer is a few rows tall
 * and the scroll rail lies in a row of its own under it. There the hint takes
 * the room beside the rail, where it covers neither a line nor a button.
 */
export type HintEnd = "top" | "bottom";

type Edges = { top: number; bottom: number };

/** The hint's height and offset, plus room for the selection's handles beside it. */
const HINT_REACH_PX = 88;

/**
 * The end the hint takes for a selection inside `stage`. It moves only when
 * exactly one end is clear: a selection under both, or under neither, leaves it
 * where it is rather than have it jump about.
 */
export function selectHintEnd(current: HintEnd, selection: Edges | null, stage: Edges, reach = HINT_REACH_PX): HintEnd {
  if (!selection) return current;
  const underTop = selection.top < stage.top + reach;
  const underBottom = selection.bottom > stage.bottom - reach;
  if (underTop === underBottom) return current;
  return underTop ? "bottom" : "top";
}

/** The room beside a rail lying under the buffer, as insets from the stage's two sides. */
export type RailRoom = { start: number; end: number };

type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "height">;

/**
 * Where the hint fits beside the scroll rail, or null when the rail stands at
 * the buffer's side or is not shown at all (a mouse has none): then the hint
 * floats over the buffer as usual.
 */
export function roomBesideRail(stage: Box, term: Box, rail: Box): RailRoom | null {
  if (rail.height <= 0 || rail.top < term.bottom - 1) return null;
  return { start: Math.max(0, term.left - stage.left), end: Math.max(0, stage.right - rail.left) };
}

function measureRailRoom(stage: Element): RailRoom | null {
  const term = stage.querySelector(".term");
  const rail = stage.querySelector(".full-terminal-scroll");
  if (!term || !rail) return null;
  return roomBesideRail(stage.getBoundingClientRect(), term.getBoundingClientRect(), rail.getBoundingClientRect());
}

export function SelectHint() {
  const root = useRef<HTMLDivElement>(null);
  const [end, setEnd] = useState<HintEnd>("top");
  const [rail, setRail] = useState<RailRoom | null>(null);

  useLayoutEffect(() => {
    const stage = root.current?.parentElement;
    const doc = root.current?.ownerDocument;
    const view = doc?.defaultView;
    if (!stage || !doc || !view) return;
    const place = (): void => {
      const selection = doc.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!stage.contains(range.commonAncestorContainer)) return;
      const box = stage.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      setEnd((current) => selectHintEnd(current, rect, box));
    };
    // The rail's row comes and goes with the screen's shape: a rotation moves the hint.
    const fit = (): void => {
      const next = measureRailRoom(stage);
      setRail((current) => current?.start === next?.start && current?.end === next?.end ? current : next);
    };
    fit();
    // The mode is entered first and its opening range set right after, so the
    // first placement waits for the frame: before paint, with the range there.
    const frame = view.requestAnimationFrame(place);
    doc.addEventListener("selectionchange", place);
    view.addEventListener("resize", fit);
    return () => {
      view.cancelAnimationFrame(frame);
      doc.removeEventListener("selectionchange", place);
      view.removeEventListener("resize", fit);
    };
  }, []);

  const where = rail ? " is-beside-rail" : end === "bottom" ? " is-below" : "";
  const room = rail
    ? { "--select-hint-start": `${rail.start}px`, "--select-hint-end": `${rail.end}px` } as CSSProperties
    : undefined;
  return <div ref={root} className={`select-hint${where}`} style={room} role="status">
    <span className="select-hint-label"><b>{t("rowbar.selecting")}</b> · {t("rowbar.selectingHint")}</span>
    <Button className="select-done" onClick={() => toggleTermSelect(false)}>{t("rowbar.done")}</Button>
  </div>;
}
