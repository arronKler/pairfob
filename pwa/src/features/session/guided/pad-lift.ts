/**
 * The guided transcript's answer to the floating key panel.
 *
 * The panel covers the bottom of the buffer without taking layout height, the
 * way the complete terminal's panel covers its host. The last rendered line
 * slides up only until it clears the panel's top edge; older lines are clipped
 * at the buffer's top. The term stays the scroller it was: this is a transform
 * on its content, not a scroll, so output keeps following without a reflow.
 */

/** Where the last line is now, and where the panel starts. */
function liftDelta(lastLineBottom: number, panelTop: number, gap: number): number {
  return Math.ceil(lastLineBottom - panelTop + gap);
}

export function guidedLiftAmount(args: {
  termBottom: number;
  panelTop: number;
  lastLineBottom: number | null;
  /** What the term is already lifted by; the measurement is relative to it. */
  current: number;
  gap?: number;
}): number {
  const cover = Math.max(0, args.termBottom - args.panelTop);
  if (!(cover > 0) || args.lastLineBottom === null) return 0;
  const gap = args.gap ?? 4;
  return Math.max(0, Math.min(cover, args.current + liftDelta(args.lastLineBottom, args.panelTop, gap)));
}

export function liftGuidedPane(term: HTMLElement, panel: HTMLElement | null): void {
  if (!panel) { resetGuidedLift(term); return; }
  const termRect = term.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const lines = term.querySelectorAll<HTMLElement>(".term-line");
  const last = lines.length ? lines[lines.length - 1] : null;
  const current = Number.parseFloat(term.style.getPropertyValue("--pad-lift")) || 0;
  const lift = guidedLiftAmount({
    termBottom: termRect.bottom,
    panelTop: panelRect.top,
    lastLineBottom: last ? last.getBoundingClientRect().bottom : null,
    current,
  });
  term.style.setProperty("--pad-lift", `${lift}px`);
  term.classList.toggle("is-pad-lifted", lift > 0);
}

export function resetGuidedLift(term: HTMLElement): void {
  term.classList.remove("is-pad-lifted");
  term.style.setProperty("--pad-lift", "0px");
}