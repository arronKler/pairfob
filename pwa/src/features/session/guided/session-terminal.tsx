import { useEffect, useRef, useSyncExternalStore } from "react";
import { lineFillBackground, paintLines, spanCss, type StyledLine } from "../../../lib/ansi";
import { t } from "../../../lib/i18n";
import { openPaneId, paneFollow, paneUnread, setPaneFollow, termSelect } from "../session-store";
import { termWrap } from "../../settings/preferences-store";
import { haptic } from "../../../lib/dom";
import { echoGhost, echoStoreRevision, subscribeEcho } from "./echo";
import { openRow } from "./rowbar";
import {
  atBottom,
  bindPinch,
  bindTap,
  cancelTermJump,
  displayedTermModel,
  guidedCapturePan,
  jumpToBottom,
  pageScrollLines,
  sendGuidedTuiScroll,
  subscribeTermDisplay,
  syncJump,
  termDisplayStoreRevision,
  termJumpLeaving,
} from "./term";
import { paneModel } from "./pane-model";
import { unreadBars, unreadCount } from "./unread";
import { bindHostScroll } from "../full-terminal/full-terminal-scroll";
import { SessionScrollRail } from "./session-scroll";

function TermLine({
  line,
  index,
  ghost,
}: {
  line: StyledLine;
  index: number;
  ghost: { text: string; rollback: boolean } | null;
}) {
  const fill = lineFillBackground(line.spans);
  return (
    <div className="term-line" data-row={String(index)} style={fill ? { backgroundColor: fill } : undefined}>
      {line.spans.length
        ? line.spans.map((span, spanIndex) => (
            <span key={spanIndex} style={spanCss(span.style)}>{span.text || "\u00a0"}</span>
          ))
        : "\u00a0"}
      {ghost?.text ? (
        <span className={ghost.rollback ? "term-ghost is-rollback" : "term-ghost"} aria-hidden="true">{ghost.text}</span>
      ) : null}
    </div>
  );
}

function ghostRowIndex(lines: StyledLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].text.trim()) return i;
  }
  return lines.length - 1;
}

function JumpChip({ jumpRef }: { jumpRef: { current: HTMLButtonElement | null } }) {
  const leaving = termJumpLeaving();
  const hidden = leaving ? false : paneFollow() || !paneUnread();
  const count = unreadCount();
  const label = count > 0 ? t("term.jumpLines", { n: count }) : t("term.newOutput");
  const bars = unreadBars();
  return (
    <button
      ref={jumpRef}
      type="button"
      className={leaving ? "term-jump term-jump-out" : "term-jump"}
      hidden={hidden}
      aria-label={label}
      onClick={() => {
        const jump = jumpRef.current;
        if (!jump) return;
        haptic(6);
        jumpToBottom(jump);
      }}
    >
      <span className="term-jump-text">{label}</span>
      {bars.length ? (
        <span className="term-jump-preview" aria-hidden="true">
          {bars.map((fill, i) => (
            <span key={i} className="term-jump-bar" style={{ width: `${Math.max(12, Math.round(fill * 100))}%` }} />
          ))}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Guided pane terminal for the session root.
 *
 * DOM: `.term-wrap > .term[role=log] > .term-inner > .term-line[data-row]`,
 * plus sibling `.full-terminal-scroll` and `.term-jump`. Persist one React
 * root across paints so `.term` keeps identity. Native tap/pinch/host-scroll
 * bind in an effect and must be disposed on unmount; do not open the guided
 * TerminalScroll bridge during render. Rows follow `displayedTermModel` so a
 * text-selection freeze survives a root repaint. Ghost, jump, and page-pending
 * updates arrive through `subscribeEcho` / `subscribeTermDisplay` /
 * `subscribePagePending` rather than a single global observer.
 */
export function SessionTerminal({ onRow }: { onRow?: (index: number) => void } = {}) {
  useSyncExternalStore(subscribeEcho, echoStoreRevision);
  useSyncExternalStore(subscribeTermDisplay, termDisplayStoreRevision);
  const handleRow = onRow ?? openRow;
  const onRowRef = useRef(handleRow);
  onRowRef.current = handleRow;
  const termRef = useRef<HTMLDivElement>(null);
  const jumpRef = useRef<HTMLButtonElement>(null);
  const model = displayedTermModel(paneModel());
  const painted = paintLines(model.lines);
  const live = painted.length ? painted : [{ text: "", spans: [] as StyledLine["spans"] }];
  const ghost = echoGhost(openPaneId());
  const ghostAt = ghost.text ? ghostRowIndex(live) : -1;

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const stopTap = bindTap(term, (index) => onRowRef.current(index));
    const stopPinch = bindPinch(term);
    const stopHost = bindHostScroll(
      term,
      (direction, lines, source) => sendGuidedTuiScroll(direction, lines, source),
      () => undefined,
      { grabTouch: false, tapAsClick: false, capturePan: guidedCapturePan },
    );
    const onScroll = () => {
      const following = atBottom(term);
      if (following !== paneFollow()) {
        setPaneFollow(following);
        syncJump();
      }
    };
    term.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stopTap();
      stopPinch();
      stopHost();
      term.removeEventListener("scroll", onScroll);
      cancelTermJump();
    };
  }, []);

  const termClass = `term${termWrap() ? " wrapped" : ""}${termSelect() ? " selecting" : ""}`;
  return (
    <div className="term-wrap" data-react-session-terminal="">
      <div ref={termRef} className={termClass} role="log" aria-label={t("term.screenAria")}>
        <div className="term-inner">
          {live.map((line, index) => (
            <TermLine key={index} line={line} index={index} ghost={index === ghostAt ? ghost : null} />
          ))}
        </div>
      </div>
      <SessionScrollRail scroll={sendGuidedTuiScroll} pageLines={pageScrollLines} />
      <JumpChip jumpRef={jumpRef} />
    </div>
  );
}
