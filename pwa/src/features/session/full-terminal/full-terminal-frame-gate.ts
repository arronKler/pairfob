/** Snapshot deltas need a matching full grid; raw streams must retain every byte. */
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

  settle(sequence: bigint, full: boolean, gridMatches: boolean, rawStream = false): "render" | "wait" {
    this.lastSequence = sequence;
    // Raw PTY deltas cannot be skipped: Core sends only one initial full frame.
    if (rawStream) {
      if (this.needsFullFrame && !full) return "wait";
      this.needsFullFrame = false;
      return "render";
    }
    if (!gridMatches) {
      this.needsFullFrame = true;
      return "wait";
    }
    if (this.needsFullFrame && !full) return "wait";
    this.needsFullFrame = false;
    return "render";
  }
}
