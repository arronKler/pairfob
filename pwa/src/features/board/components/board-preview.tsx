import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
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
export function BoardAnsiPreview({
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
