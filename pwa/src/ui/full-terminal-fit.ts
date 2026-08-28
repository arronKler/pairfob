/**
 * Size the live xterm grid like a web terminal: fill the host, keep a
 * usable column count on a phone, and report the on-screen cell size.
 */

export const FULL_TERM_TARGET_COLS = 80;

export type TermFitMode = "pan" | "fit";

/** Pan keeps a classic 80-col PTY; fit shrinks the computer to the phone. */
export function ptyCols(visibleCols: number, fit: TermFitMode, target = FULL_TERM_TARGET_COLS): number {
  if (!(visibleCols > 0)) return target;
  if (fit !== "pan") return visibleCols;
  return Math.max(visibleCols, target);
}

/** Measure against the visible host, then stretch the canvas to the PTY. */
export function probePanCanvas(canvas: HTMLElement | null, hostWidth: number): void {
  if (!canvas) return;
  canvas.style.width = hostWidth > 0 ? `${Math.round(hostWidth)}px` : "";
}

export function sizePanCanvas(
  canvas: HTMLElement | null,
  pan: boolean,
  cols: number,
  cellWidth: number,
  hostWidth: number,
): void {
  if (!canvas) return;
  if (!pan || !(cols > 0) || !(cellWidth > 0)) {
    canvas.style.width = "";
    return;
  }
  canvas.style.width = `${Math.max(Math.round(hostWidth), Math.round(cols * cellWidth))}px`;
}
export const FULL_TERM_FONT_MIN = 11;
export const FULL_TERM_FONT_MAX = 22;
export const FULL_TERM_FONT_FAMILY =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export type CellSize = { width: number; height: number };

export type HostInner = { width: number; height: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function snapFont(value: number): number {
  return Math.round(value);
}

/** Content box of the xterm host. `clientWidth` includes padding. */
export function hostInnerSize(host: HTMLElement): HostInner {
  const style = window.getComputedStyle(host);
  const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  return {
    width: Math.max(0, host.clientWidth - padX),
    height: Math.max(0, host.clientHeight - padY),
  };
}

/**
 * Shrink the type scale until `targetCols` fit, unless the user locked a
 * size with pinch. Never goes below `min`; never grows past `preferred`.
 */
export function pickFontSize(args: {
  hostWidth: number;
  cellWidthAt: (fontSize: number) => number;
  preferred: number;
  locked: boolean;
  min?: number;
  max?: number;
  targetCols?: number;
}): number {
  const min = args.min ?? FULL_TERM_FONT_MIN;
  const max = args.max ?? FULL_TERM_FONT_MAX;
  const target = args.targetCols ?? FULL_TERM_TARGET_COLS;
  let font = clamp(snapFont(args.preferred), min, max);
  if (args.locked || !(args.hostWidth > 0)) return font;
  const colsAt = (size: number): number => {
    const cell = args.cellWidthAt(size);
    return cell > 0 ? Math.floor(args.hostWidth / cell) : 0;
  };
  if (colsAt(font) >= target) return font;
  while (font > min) {
    const next = snapFont(Math.max(min, font - 1));
    if (next === font) break;
    font = next;
    if (colsAt(font) >= target) return font;
  }
  return font;
}

/**
 * Minimum row pitch. 4/3 still clips PingFang fallbacks at 8–12px; 1.5
 * matches a typical CJK terminal. Do not stretch past this to fill leftover
 * host pixels — that is what put rows on fractional CSS pixels.
 */
export const FULL_TERM_LINE_HEIGHT = 1.5;

const GLYPH_PROBE = "W字█Åg";

/** Tallest ink box for the live font, including CJK fallback and bold. */
export function measureGlyphHeight(fontFamily: string, fontSize: number): number {
  if (!(fontSize > 0) || typeof document === "undefined") return fontSize;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:absolute",
    "left:-9999px",
    "top:0",
    "visibility:hidden",
    "white-space:pre",
    "line-height:1",
    `font:${fontSize}px ${fontFamily}`,
  ].join(";");
  probe.textContent = GLYPH_PROBE;
  document.body.append(probe);
  let height = probe.getBoundingClientRect().height;
  probe.style.fontWeight = "700";
  height = Math.max(height, probe.getBoundingClientRect().height);
  probe.remove();
  return height > 0 ? height : fontSize;
}

/**
 * xterm CSS cell height: round(floor(ceil(font*dpr)*lh)*rows/dpr)/rows.
 * If that is not an integer, adjacent DOM rows share a device pixel.
 */
export function xtermCssCellHeight(fontSize: number, lineHeight: number, dpr: number, rows: number): number {
  if (!(fontSize > 0) || !(lineHeight > 0) || !(dpr > 0) || !(rows > 0)) return 0;
  const deviceChar = Math.ceil(fontSize * dpr);
  const deviceCell = Math.floor(deviceChar * lineHeight);
  return Math.round((deviceCell * rows) / dpr) / rows;
}

/** Smallest lineHeight ≥ min whose xterm cell height is an integer CSS pixel. */
export function lineHeightForIntegerCells(args: {
  fontSize: number;
  minLineHeight: number;
  dpr: number;
  rows: number;
}): number {
  const fontSize = args.fontSize;
  const dpr = args.dpr > 0 ? args.dpr : 1;
  const rows = args.rows > 0 ? args.rows : 24;
  const minLh = args.minLineHeight > 0 ? args.minLineHeight : FULL_TERM_LINE_HEIGHT;
  if (!(fontSize > 0)) return minLh;
  const deviceChar = Math.max(1, Math.ceil(fontSize * dpr));
  const minDeviceCell = Math.max(deviceChar, Math.ceil(deviceChar * minLh - 1e-6));
  for (let deviceCell = minDeviceCell; deviceCell <= minDeviceCell + 32; deviceCell++) {
    const cssCanvas = Math.round((deviceCell * rows) / dpr);
    if (cssCanvas % rows !== 0) continue;
    const cssCell = cssCanvas / rows;
    if (cssCell + 1e-6 < fontSize) continue;
    return deviceCell / deviceChar;
  }
  return minLh;
}

export function pitchLineHeight(fontSize: number, glyphHeight: number, dpr: number, rows: number): number {
  const needed = fontSize > 0 && glyphHeight > 0 ? (glyphHeight + 1) / fontSize : FULL_TERM_LINE_HEIGHT;
  return lineHeightForIntegerCells({
    fontSize,
    minLineHeight: Math.max(FULL_TERM_LINE_HEIGHT, needed),
    dpr,
    rows,
  });
}

/** After xterm measures, bump lineHeight so the used CSS cell is an integer. */
export function snapCellLineHeight(lineHeight: number, cellHeight: number): number {
  if (!(lineHeight > 0) || !(cellHeight > 0)) return lineHeight;
  const snapped = Math.ceil(cellHeight - 1e-6);
  if (snapped <= cellHeight + 0.02) return lineHeight;
  return lineHeight * (snapped / cellHeight);
}

/**
 * Local xterm grid: never larger than the phone host, never larger than the
 * last remote frame. A split pane on the computer often paints 20–24 rows
 * into a 40-row phone host; keeping the extra empty rows letterboxes the TUI.
 */
export function displayGrid(
  fitted: { cols: number; rows: number },
  remote: { cols: number; rows: number } | null,
): { cols: number; rows: number } {
  if (!remote || !(remote.cols > 0) || !(remote.rows > 0)) return fitted;
  return {
    cols: Math.min(fitted.cols, remote.cols),
    rows: Math.min(fitted.rows, remote.rows),
  };
}

/**
 * Chrome/iOS may paint a larger font than xterm asked for (minimum font size,
 * Dynamic Type). Metrics must follow the painted size or glyphs overflow the cell.
 */
export function paintedFontSize(host: HTMLElement, requested: number): number {
  const el = host.querySelector(".xterm-rows");
  if (!(el instanceof HTMLElement) || !(requested > 0)) return requested;
  const painted = Number.parseFloat(window.getComputedStyle(el).fontSize);
  if (!Number.isFinite(painted)) return requested;
  return Math.max(requested, Math.round(painted));
}

/** Drop a leftover CSS scale so rows sit on the measured cell grid. */
export function clearScreenScale(host: HTMLElement): void {
  const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screen) return;
  screen.style.transform = "";
  screen.style.transformOrigin = "";
}

/** Pin xterm's DOM rows to integer CSS pixels so adjacent rows cannot share a device pixel. */
export function integerizeDomRows(host: HTMLElement, cellHeight: number): void {
  const snap = Math.max(1, Math.round(cellHeight));
  for (const node of host.querySelectorAll(".xterm-rows > div")) {
    if (!(node instanceof HTMLElement)) continue;
    node.style.height = `${snap}px`;
    node.style.lineHeight = `${snap}px`;
    node.style.overflow = "hidden";
  }
}

export function visualCells(host: HTMLElement, cols: number, rows: number): CellSize {
  const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
  const rect = (screen ?? host).getBoundingClientRect();
  return {
    width: cols > 0 && rect.width > 0 ? Math.max(1, Math.round(rect.width / cols)) : 0,
    height: rows > 0 && rect.height > 0 ? Math.max(1, Math.round(rect.height / rows)) : 0,
  };
}

export function cssCellOf(terminal: object): CellSize | null {
  const core = terminal as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
  };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  if (!cell || !(cell.width > 0) || !(cell.height > 0)) return null;
  return { width: cell.width, height: cell.height };
}

/**
 * Two-finger pinch changes the live type scale. The PWA itself is
 * fixed-scale, so the browser will not do this for us.
 */
export function bindFontPinch(
  host: HTMLElement,
  getFont: () => number,
  setFont: (px: number) => void,
): () => void {
  let base = 0;
  let basePx = 0;
  const spread = (touches: TouchList): number => {
    const a = touches[0];
    const b = touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  const onStart = (event: TouchEvent) => {
    if (event.touches.length !== 2) return;
    base = spread(event.touches);
    basePx = getFont();
  };
  const onMove = (event: TouchEvent) => {
    if (event.touches.length !== 2 || base <= 0) return;
    event.preventDefault();
    const next = clamp(snapFont(basePx * (spread(event.touches) / base)), FULL_TERM_FONT_MIN, FULL_TERM_FONT_MAX);
    if (next === getFont()) return;
    setFont(next);
  };
  const settle = () => {
    base = 0;
  };
  host.addEventListener("touchstart", onStart, { passive: true });
  host.addEventListener("touchmove", onMove, { passive: false });
  host.addEventListener("touchend", settle);
  host.addEventListener("touchcancel", settle);
  return () => {
    host.removeEventListener("touchstart", onStart);
    host.removeEventListener("touchmove", onMove);
    host.removeEventListener("touchend", settle);
    host.removeEventListener("touchcancel", settle);
  };
}
