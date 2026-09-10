/** Keep ANSI deltas behind a complete frame for the renderer's current grid. */
export class FullTerminalFrameGate {
  private lastSequence: bigint | null = null;
  private needsFullFrame = true;

  reset(): void {
    this.lastSequence = null;
    this.needsFullFrame = true;
  }

  preflight(sequence: bigint, full: boolean): "accept" | "stale" | "gap" {
    if (this.lastSequence !== null && sequence <= this.lastSequence) return "stale";
    if (!full && this.lastSequence !== null && sequence !== this.lastSequence + 1n) return "gap";
    return "accept";
  }

  settle(sequence: bigint, full: boolean, gridMatches: boolean): "render" | "wait" {
    this.lastSequence = sequence;
    if (!gridMatches) {
      this.needsFullFrame = true;
      return "wait";
    }
    if (this.needsFullFrame && !full) return "wait";
    this.needsFullFrame = false;
    return "render";
  }
}
