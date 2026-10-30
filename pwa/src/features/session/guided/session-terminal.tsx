import { ArrowDown } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { lineFillBackground, paintLines, plainCellClass, spanCss, spanInk, type StyledLine } from "../../../lib/ansi";
import { t } from "../../../lib/i18n";
import { openPaneId, paneFollow, paneLoaded, paneUnread, sessionStore, setPaneFollow, termSelect } from "../session-store";
import { termWrap } from "../../settings/preferences-store";
import { haptic } from "../../../lib/dom";
import { echoGhost, echoStoreRevision, subscribeEcho } from "./echo";
import { closeRow, openRow } from "./rowbar";
import {
  atBottom,
  bindDragSelection,
  bindPinch,
  bindTap,
  cancelTermJump,
  displayedTermModel,
  guidedCapturePan,
  jumpToBottom,
  pageScrollLines,
  selectFromHold,
  sendGuidedTuiScroll,
  subscribeTermDisplay,
  syncJump,
  termDisplayStoreRevision,
  termJumpLeaving,
  type RowPress,
} from "./term";
import { paneModel } from "./pane-model";
import { unreadBars, unreadCount } from "./unread";
import { bindHostScroll } from "../full-terminal/full-terminal-scroll";
import { deskPointer, useDeskPointer } from "../desk-pointer";
import { SessionScrollRail } from "./session-scroll";
import { TermReading } from "./term-reading";
import { cellText } from "../../../shared/ui/primitives";

/**
 * One rendered row. Memoised on its own line: an echo, the jump chip or the
 * picked row repaints the terminal, and only the rows that changed redraw.
 */
const TermLine = memo(function TermLine({
  line,
  index,
  ghost,
  picked,
}: {
  line: StyledLine;
  index: number;
  ghost: { text: string; rollback: boolean } | null;
  picked: boolean;
}) {
  const fill = lineFillBackground(line.spans);
  return (
    <div className={picked ? "term-line is-picked" : "term-line"} data-row={String(index)} style={fill ? { backgroundColor: fill } : undefined}>
      {line.spans.length
        ? line.spans.map((span, spanIndex) => {
            const css = spanCss(span.style, span.text);
            const ink = spanInk(span.style);
            return <span key={spanIndex} className={plainCellClass(css, fill)} style={css}>{cellText(span.text || "\u00a0", css.color !== ink ? ink ?? "var(--term-ink)" : undefined)}</span>;
          })
        : "\u00a0"}
      {ghost?.text ? (
        <span className={ghost.rollback ? "term-ghost is-rollback" : "term-ghost"} aria-hidden="true">{ghost.text}</span>
      ) : null}
    </div>
  );
});

/** A screen with no rows still draws one empty line, from the same array every time. */
const EMPTY_LINES: StyledLine[] = [{ text: "", spans: [] }];

function pickedRow(): number | null {
  return sessionStore.get().paneRow;
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
      <span className="term-jump-text"><ArrowDown size={16} aria-hidden="true" />{label}</span>
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
 *
 * Gestures: tap a row → floating row actions (`onRow`); long-press → native
 * selection; a hand pan dismisses the row actions. The picked row is read as a
 * narrow session-store slice so highlighting it does not wait for a pane commit.
 * A mouse beside the list drags to select instead: the drag is the browser's,
 * a click that did not move is still the row gesture.
 */
export function SessionTerminal({ onRow }: { onRow?: (index: number, at?: RowPress) => void } = {}) {
  useSyncExternalStore(subscribeEcho, echoStoreRevision);
  useSyncExternalStore(subscribeTermDisplay, termDisplayStoreRevision);
  const picked = useSyncExternalStore(sessionStore.subscribe, pickedRow, pickedRow);
  // The screen is what the daemon last sent; until it lands the pane draws the
  // read in progress instead of an empty buffer.
  const reading = !useSyncExternalStore(sessionStore.subscribe, paneLoaded, paneLoaded);
  const handleRow = onRow ?? openRow;
  const onRowRef = useRef(handleRow);
  onRowRef.current = handleRow;
  const termRef = useRef<HTMLDivElement>(null);
  const jumpRef = useRef<HTMLButtonElement>(null);
  const pointer = useDeskPointer();
  const model = displayedTermModel(paneModel());
  // Painted rows keep their identity per buffer: an echo or a picked row repaints
  // the terminal, and the rows it did not change skip their render entirely.
  const painted = useMemo(() => paintLines(model.lines), [model]);
  const live = painted.length ? painted : EMPTY_LINES;
  const ghost = echoGhost(openPaneId());
  const ghostAt = ghost.text ? ghostRowIndex(live) : -1;

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const stopTap = bindTap(term, (index, at) => onRowRef.current(index, at), { onHold: selectFromHold, onPan: closeRow });
    const stopPinch = bindPinch(term);
    const stopHost = bindHostScroll(
      term,
      (direction, lines, source) => sendGuidedTuiScroll(direction, lines, source),
      () => undefined,
      // A mouse drag beside the list selects text; it must not also page the agent.
      {
        grabTouch: false,
        tapAsClick: false,
        capturePan: guidedCapturePan,
        pansWith: (type) => type !== "mouse" || !deskPointer(),
        // One rendered row is one line of the remote TUI, so the pane follows the finger.
        linePx: () => term.querySelector<HTMLElement>(".term-line")?.offsetHeight ?? 0,
      },
    );
    const onScroll = () => {
      const following = atBottom(term);
      if (following !== paneFollow()) {
        setPaneFollow(following);
        syncJump();
      }
    };
    term.addEventListener("scroll", onScroll, { passive: true });
    // The buffer's box changes under it: the pad opens or closes, the field
    // grows, the keyboard rises. A box that got shorter keeps its scroll offset
    // and fires no scroll event, so a buffer that was at its end would end
    // with its last lines under the dock. Following means staying at the end.
    const Observer = term.ownerDocument.defaultView?.ResizeObserver;
    const resized = Observer ? new Observer(() => {
      if (paneFollow() && !atBottom(term)) term.scrollTop = term.scrollHeight;
    }) : null;
    resized?.observe(term);
    return () => {
      stopTap();
      stopPinch();
      stopHost();
      resized?.disconnect();
      term.removeEventListener("scroll", onScroll);
      cancelTermJump();
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !pointer) return;
    return bindDragSelection(term);
  }, [pointer]);

  const termClass = `term${termWrap() ? " wrapped" : ""}${termSelect() ? " selecting" : ""}`;
  return (
    <div className="term-wrap" data-react-session-terminal="">
      <div ref={termRef} className={termClass} role="log" aria-label={t("term.screenAria")}>
        <div className="term-inner">
          {live.map((line, index) => (
            <TermLine key={index} line={line} index={index} ghost={index === ghostAt ? ghost : null} picked={index === picked} />
          ))}
        </div>
      </div>
      {reading ? <TermReading /> : null}
      {reading ? null : <SessionScrollRail scroll={sendGuidedTuiScroll} pageLines={pageScrollLines} />}
      {reading ? null : <JumpChip jumpRef={jumpRef} />}
    </div>
  );
}
