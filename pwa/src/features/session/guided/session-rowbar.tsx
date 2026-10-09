import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../../lib/i18n";
import { bindRowBubble, closeRow, copyRow, placeRowBubble, quoteRow, rowBarContent } from "./rowbar";
import { paneModel } from "./pane-model";
import { sessionStore } from "../session-store";
import { selectTermRow } from "./term";
import { Button } from "../../../shared/ui/primitives";

/** How long the bubble stays to say "copied" on the pressed action before it closes. */
export const ROW_COPIED_MS = 900;

type Copied = { index: number; what: "line" | "path" };

function pickedRow(): number | null {
  return sessionStore.get().paneRow;
}

/**
 * Floating actions for the picked terminal row (`state.paneRow`).
 *
 * DOM: `.row-bubble[role=toolbar] > .row-act`, absolutely positioned in the
 * pane's `.term-stage` above (or below) `.term-line.is-picked`, so opening it
 * never shifts the buffer. Empty rows are discarded by `discardEmptyPaneRow`
 * in a controller, never during render. Returns null when there is no
 * copyable row.
 *
 * A copy is confirmed here, on the action that was pressed, and the bubble
 * then closes by itself. Picking another row meanwhile moves the bubble there
 * with its actions as they were.
 */
export function SessionRowBar() {
  // The picked row is a narrow slice: the bubble follows it without waiting for a pane commit.
  useSyncExternalStore(sessionStore.subscribe, pickedRow, pickedRow);
  const content = rowBarContent(paneModel());
  const bubble = useRef<HTMLDivElement>(null);
  const index = content?.index ?? null;
  useLayoutEffect(() => {
    if (index !== null && bubble.current) placeRowBubble(bubble.current, index);
  });
  useEffect(() => {
    if (index === null || !bubble.current) return;
    return bindRowBubble(bubble.current, index);
  }, [index]);
  // A new object for every press, so pressing again restarts the wait.
  const [copied, setCopied] = useState<Copied | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(null);
      if (pickedRow() === copied.index) closeRow();
    }, ROW_COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!content) return null;
  const { text, path } = content;
  const done = copied?.index === content.index ? copied.what : null;
  const copy = (value: string, what: Copied["what"]): void => {
    void copyRow(value).then((ok) => { if (ok) setCopied({ index: content.index, what }); });
  };
  return (
    <div ref={bubble} className="row-bubble" role="toolbar" aria-label={t("rowbar.aria")} data-react-session-rowbar="">
      <Button className="row-act" data-copied={done === "line" ? "" : undefined}
        data-reserve={t(done === "line" ? "rowbar.copy" : "rowbar.copied")}
        aria-label={t(done === "line" ? "row.copiedLine" : "rowbar.copyAria")} onClick={() => copy(text, "line")}>
        {t(done === "line" ? "rowbar.copied" : "rowbar.copy")}
      </Button>
      {path ? (
        <Button className="row-act" data-copied={done === "path" ? "" : undefined}
          data-reserve={t(done === "path" ? "rowbar.copyPath" : "rowbar.copied")}
          aria-label={done === "path" ? t("row.copiedPath") : t("rowbar.copyPathAria", { path })} title={path}
          onClick={() => copy(path, "path")}>
          {t(done === "path" ? "rowbar.copied" : "rowbar.copyPath")}
        </Button>
      ) : null}
      <Button className="row-act" aria-label={t("rowbar.quoteAria")} onClick={() => quoteRow(text)}>
        {t("rowbar.quote")}
      </Button>
      <Button className="row-act" aria-label={t("rowbar.selectAria")} onClick={() => selectTermRow(content.index)}>
        {t("rowbar.select")}
      </Button>
    </div>
  );
}
