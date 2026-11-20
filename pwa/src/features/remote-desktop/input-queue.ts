import type { DesktopEvent } from "../../lib/protocol/remote-desktop";

const continuous = (event: DesktopEvent) => event.kind === "move" || event.kind === "scroll";
const scrollDelta = (delta: number) => Math.max(-1500, Math.min(1500, delta));

export class DesktopInputQueue {
  private queue: DesktopEvent[] = [];
  private inFlight = 0;
  private frame = 0;
  private stopped = false;

  constructor(private write: (e: DesktopEvent) => Promise<unknown>, private failed: () => void) {}

  send(event: DesktopEvent) {
    if (this.stopped) return false;
    const last = this.queue.at(-1);
    if (event.kind === "move" && last?.kind === "move") this.queue.pop();
    if (event.kind === "scroll" && last?.kind === "scroll") {
      this.queue.pop();
      event = { ...event, dx: scrollDelta(last.dx + event.dx), dy: scrollDelta(last.dy + event.dy) };
    }
    if (this.queue.length >= 32) {
      const discard = this.queue.findIndex(continuous);
      if (discard >= 0) this.queue.splice(discard, 1);
      else if (continuous(event)) return false;
      else { this.failed(); return false; }
    }
    this.queue.push(event);
    if (!continuous(event)) this.flush();
    else if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.flush(); });
    return true;
  }

  release() {
    this.queue = [];
    this.send({ kind: "release" });
  }

  private flush() {
    while (!this.stopped && this.inFlight < 4 && this.queue.length) {
      this.inFlight++;
      void this.write(this.queue.shift()!).catch(() => { if (!this.stopped) this.failed(); })
        .finally(() => { this.inFlight--; this.flush(); });
    }
  }

  close() {
    this.stopped = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.queue = [];
  }
}
