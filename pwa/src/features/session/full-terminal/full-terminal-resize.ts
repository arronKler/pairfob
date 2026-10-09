type Grid = { cols: number; rows: number };
type Cell = { cellWidth: number; cellHeight: number };
type Request = Grid & Cell;

const sameCell = (a: Cell, b: Cell): boolean => a.cellWidth === b.cellWidth && a.cellHeight === b.cellHeight;

/**
 * What the computer's terminal was last asked to be.
 *
 * Several things refit the renderer (the host resizing, a pinch, a new width
 * mode, the computer's frame changing size), and more than one of them fires
 * for a single change: a window resize refits, and so does the frame that
 * answers it. The computer is asked once per size. A fit that lands on the
 * size already requested sends nothing, unless the computer's own frame says
 * it is somewhere else and has to be told again.
 *
 * A bridge opens with a grid only, so the cell's pixel size is still owed
 * afterwards. It goes with the answer to the computer's first frame, the way
 * it always has. A refit before that frame is not the moment for it: a draft
 * growing a line resizes the host and leaves the grid alone, and asking the
 * computer for the grid it already has would be a resize nothing changed for.
 * Only a new type size (a pinch) is news by itself that early.
 */
export class FullTerminalResizeGate {
  private asked: Grid | null = null;
  /** The cell size the computer was told; null while the open's is still owed. */
  private told: Cell | null = null;
  /** The cell size last fitted while it was owed, to tell a pinch from a refit. */
  private fitted: Cell | null = null;

  /** The bridge opened with this grid. */
  opened(grid: Grid): void {
    this.asked = { cols: grid.cols, rows: grid.rows };
    this.told = null;
    this.fitted = null;
  }

  /** Whether `size` is news to the computer; `remote` is the grid its latest frame reported. */
  admit(size: Request, remote?: Grid | null): boolean {
    const asked = this.asked;
    const sameGrid = asked !== null && asked.cols === size.cols && asked.rows === size.rows;
    const elsewhere = Boolean(remote && (remote.cols !== size.cols || remote.rows !== size.rows));
    const cellKnown = this.told ? sameCell(this.told, size) : !remote && (!this.fitted || sameCell(this.fitted, size));
    if (sameGrid && cellKnown && !elsewhere) {
      if (!this.told) this.fitted = { cellWidth: size.cellWidth, cellHeight: size.cellHeight };
      return false;
    }
    this.asked = { cols: size.cols, rows: size.rows };
    this.told = { cellWidth: size.cellWidth, cellHeight: size.cellHeight };
    this.fitted = null;
    return true;
  }
}
