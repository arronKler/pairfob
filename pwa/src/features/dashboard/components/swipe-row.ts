/**
 * Horizontal swipe on a list row.
 *
 * Touch and pen only: a mouse keeps the plain click and right-click menu. A drag
 * becomes a swipe once it moves more than the slop sideways and further sideways
 * than down, so vertical scrolling and the long-press menu keep working. The
 * click that ends a swipe is swallowed so the row does not also open.
 */
const SLOP_PX = 10;
const RIGHT_COMMIT_PX = 88;

export type SwipeRowOptions = {
  /** The element that slides; the actions sit behind it. */
  foreground: () => HTMLElement | null;
  /** Width of the trailing actions revealed by a left swipe. */
  trailingWidth: number;
  /** A right swipe is offered only while this is true (an unread completion). */
  canCommitRight: () => boolean;
  onCommitRight: () => void;
};

let openRow: { row: HTMLElement; close: () => void } | null = null;

/** Close whichever row is currently open (a scroll, a tap elsewhere). */
export function closeOpenSwipeRow(): void {
  openRow?.close();
}

/**
 * Close the open row for a press that landed on `target`, unless the press is
 * on that row: its own swipe, a tap that settles it, or one of the actions it
 * uncovered. The press is only observed, so whatever it hit still acts.
 */
export function closeSwipeRowOutside(target: EventTarget | null): void {
  if (!openRow) return;
  const inside = typeof (target as Node | null)?.nodeType === "number" && openRow.row.contains(target as Node);
  if (!inside) openRow.close();
}

export function bindSwipeRow(row: HTMLElement, options: SwipeRowOptions): () => void {
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let base = 0;
  let offset = 0;
  let mode: "idle" | "undecided" | "swipe" | "scroll" = "idle";
  let eatClick = false;

  const paint = (x: number, animate: boolean) => {
    const fg = options.foreground();
    if (!fg) return;
    row.classList.toggle("is-dragging", !animate);
    // Only a row pulled to the right shows the leading action: it spans the whole
    // row, so under a left swipe it would cover the trailing pair.
    row.classList.toggle("is-leading", x > 0);
    fg.style.transform = x ? `translateX(${x}px)` : "";
  };
  const close = () => {
    base = 0;
    row.classList.remove("is-open");
    paint(0, true);
    if (openRow?.row === row) openRow = null;
  };
  const open = () => {
    if (openRow && openRow.row !== row) openRow.close();
    base = -options.trailingWidth;
    row.classList.add("is-open");
    paint(base, true);
    openRow = { row, close };
  };

  row.addEventListener("pointerdown", (event) => {
    // A swipe that ended without a click must not swallow the next real tap
    // (for example on a revealed action).
    eatClick = false;
    if (!event.isPrimary || event.pointerType === "mouse") return;
    if (openRow && openRow.row !== row) openRow.close();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    offset = base;
    mode = "undecided";
  }, { signal });

  row.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || mode === "idle" || mode === "scroll") return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (mode === "undecided") {
      if (Math.abs(dx) > SLOP_PX && Math.abs(dx) > Math.abs(dy)) {
        mode = "swipe";
        try { row.setPointerCapture(event.pointerId); } catch { /* released already */ }
      } else if (Math.abs(dy) > SLOP_PX) {
        mode = "scroll";
        return;
      } else {
        return;
      }
    }
    const right = options.canCommitRight() ? RIGHT_COMMIT_PX + 40 : 0;
    offset = Math.max(-options.trailingWidth - 48, Math.min(right, base + dx));
    paint(offset, false);
  }, { signal });

  const finish = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (mode !== "swipe") { mode = "idle"; return; }
    mode = "idle";
    eatClick = true;
    if (offset >= RIGHT_COMMIT_PX && options.canCommitRight()) {
      close();
      options.onCommitRight();
    } else if (offset < -options.trailingWidth / 2) {
      open();
    } else {
      close();
    }
  };
  row.addEventListener("pointerup", finish, { signal });
  row.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    mode = "idle";
    if (base) open(); else close();
  }, { signal });

  // The click that ends a swipe, or a tap on an open row's foreground, only
  // settles the row; it never opens the pane underneath.
  row.addEventListener("click", (event) => {
    const onForeground = options.foreground()?.contains(event.target as Node) === true;
    if (!onForeground) {
      // A revealed action ran; the row slides shut behind it.
      if (row.classList.contains("is-open")) close();
      return;
    }
    if (eatClick) {
      // The click that ends a swipe only settles the row it just moved.
      eatClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (row.classList.contains("is-open")) {
      // A tap on an open row closes it instead of opening the pane.
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  }, { capture: true, signal });

  return () => {
    // A row released while open (its actions moved out from behind it) must not
    // stay slid aside with nothing left to close it.
    if (openRow?.row === row) close();
    lifetime.abort();
  };
}
