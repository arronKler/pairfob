import { memo, useCallback, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { lineFillBackground, spanCss } from "../../../lib/ansi";
import { ansiPreviewModel } from "../preview/model";
import { applyBoardPreviewFont, fitPreviewBuffer } from "../preview/font";
import { boardPreviewSnapshot, subscribeBoardPreviews } from "../preview/store";

/**
 * One pane thumbnail.
 *
 * Subscribes to the preview store directly, so a `pane.read` reply repaints this
 * tile without the board re-rendering. `paint` is the parent's render token: a
 * fresh board paint measured nothing on the mounted font, only an in-place
 * preview reply may re-measure it.
 */
export const BoardAnsiPreview = memo(BoardAnsiPreviewView);

function BoardAnsiPreviewView({
  paneId,
  cols,
  rows,
  paint,
}: {
  paneId: string;
  cols: number;
  rows: number;
  paint?: object;
}) {
  const snapshot = useCallback(() => boardPreviewSnapshot(paneId), [paneId]);
  const preview = useSyncExternalStore(subscribeBoardPreviews, snapshot);
  const screenRef = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ paint?: object; preview: typeof preview } | null>(null);
  const model = ansiPreviewModel(preview?.text || "", cols, rows);
  useLayoutEffect(() => {
    const host = screenRef.current;
    if (!host) return;
    // A fresh board paint used the CSS font on detached nodes. Only an
    // in-place preview reply measured the mounted font; preserve that timing.
    if (!previous.current || previous.current.paint !== paint) host.style.fontSize = "";
    else if (previous.current.preview !== preview) applyBoardPreviewFont(host);
    fitPreviewBuffer(host);
    previous.current = { paint, preview };
  });
  const bufferStyle: CSSProperties = {
    ...(model.width > 0 && model.height > 0 ? { width: `${model.width}px`, height: `${model.height}px` } : {}),
    transformOrigin: "0 0",
  };
  return (
    <span ref={screenRef} className="board-pane-screen" aria-hidden="true">
      <div className="board-pane-buffer" style={bufferStyle}>
        {model.lines.map((line, index) => {
          const fill = lineFillBackground(line.spans);
          return (
            <div key={index} className="board-pane-line" style={fill ? { backgroundColor: fill } : undefined}>
              {line.spans.length
                ? line.spans.map((span, spanIndex) => (
                    <span key={spanIndex} style={spanCss(span.style)}>{span.text || "\u00a0"}</span>
                  ))
                : "\u00a0"}
            </div>
          );
        })}
      </div>
    </span>
  );
}

/** Lines a status card keeps: enough to fill the tallest card; CSS clips from the top. */
export const BOARD_CARD_LINES = 12;

/** The last non-empty lines of a preview, as plain text. */
export function cardLines(text: string, count = BOARD_CARD_LINES): string[] {
  return ansiPreviewModel(text).lines.map((line) => line.text.replace(/\s+$/, "")).filter(Boolean).slice(-count);
}

/**
 * The status card body: the pane's last output lines in fixed UI type, shown
 * while terminal glyphs would be too small to read (see model/tile-level).
 * Subscribes to the same preview store, so a read repaints only this card.
 */
export const BoardCardLines = memo(function BoardCardLines({ paneId }: { paneId: string }) {
  const snapshot = useCallback(() => boardPreviewSnapshot(paneId), [paneId]);
  const preview = useSyncExternalStore(subscribeBoardPreviews, snapshot);
  const lines = cardLines(preview?.text || "");
  return (
    <span className="board-pane-card" aria-hidden="true">
      {/* Top-aligned while it fits; once it overflows the oldest lines clip away at the top. */}
      <span className="board-pane-card-lines">
        {lines.map((line, index) => <span key={index} className="board-pane-card-line">{line}</span>)}
      </span>
    </span>
  );
});
