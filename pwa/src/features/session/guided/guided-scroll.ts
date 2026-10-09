import type { LiveSession, SessionEvent } from "../../../lib/protocol/client";
import { registerLivePath } from "./live-order";

export const GUIDED_SCROLL_IDLE_MS = 1_500;

type ScrollSession = Pick<LiveSession, "terminalOpen" | "terminalScroll" | "terminalClose">;

export type GuidedScrollTarget = {
  session: ScrollSession;
  paneId: string;
  cols: number;
  rows: number;
};

type ActiveBridge = GuidedScrollTarget & {
  terminalId: string;
  nextSequence: number;
  activity: number;
  tail: Promise<void>;
};

type OpeningBridge = {
  session: ScrollSession;
  paneId: string;
  promise: Promise<ActiveBridge | null>;
};

type Timer = ReturnType<typeof setTimeout>;
type ScheduleTimer = (callback: () => void, delay: number) => Timer;
type CancelTimer = (timer: Timer) => void;

/**
 * Guided panes are snapshots, so they do not otherwise own a terminal
 * controller. Open one only for a wheel burst, serialize its mutations, then
 * release it. A failed command invalidates the bridge and is never replayed.
 */
export class GuidedScrollController {
  private active: ActiveBridge | null = null;
  private opening: OpeningBridge | null = null;
  private version = 0;
  private idleTimer: Timer | null = null;
  /** Scrolls asked for and not yet written: the bridge is opening, or an earlier scroll is in flight. */
  private unwritten = 0;
  private readonly writtenWaiters: Array<() => void> = [];
  private readonly schedule: ScheduleTimer;
  private readonly cancel: CancelTimer;

  constructor(
    schedule: ScheduleTimer = globalThis.setTimeout,
    cancel: CancelTimer = globalThis.clearTimeout,
  ) {
    // Browser timers require Window as their receiver. Keeping a bare native
    // timer in an instance field and later calling `this.schedule(...)` makes
    // Chrome throw "Illegal invocation" after a successful remote scroll.
    this.schedule = (callback, delay) => schedule.call(globalThis, callback, delay);
    this.cancel = (timer) => cancel.call(globalThis, timer);
  }

  async scroll(target: GuidedScrollTarget, direction: "up" | "down", lines: number): Promise<boolean> {
    // Counted from the press to the write (or to giving up), for the session's order (`live-order`).
    this.unwritten += 1;
    let counted = true;
    const written = (): void => {
      if (!counted) return;
      counted = false;
      this.unwritten -= 1;
      if (this.unwritten === 0) for (const resolve of this.writtenWaiters.splice(0)) resolve();
    };
    try {
      const bridge = await this.ensureBridge(target);
      if (!bridge || this.active !== bridge) return false;
      this.clearIdleTimer();
      const activity = ++bridge.activity;
      const count = Number.isFinite(lines) ? Math.min(160, Math.max(1, Math.round(lines))) : 1;
      const request = bridge.tail.then(async () => {
        if (this.active !== bridge) return;
        const sequence = bridge.nextSequence;
        const sent = bridge.session.terminalScroll(bridge.terminalId, sequence, direction, count, "wheel");
        written();
        await sent;
        bridge.nextSequence += 1;
      });
      bridge.tail = request.then(
        () => undefined,
        () => this.dropBridge(bridge, true),
      );
      await request;
      if (this.active === bridge && bridge.activity === activity) this.scheduleIdleRelease(bridge);
      return this.active === bridge;
    } finally {
      written();
    }
  }

  /** A scroll has been asked for and not written yet. */
  unsent(): boolean {
    return this.unwritten > 0;
  }

  /** Settles when every scroll asked for so far has been written, or dropped. */
  written(): Promise<void> {
    if (!this.unwritten) return Promise.resolve();
    return new Promise<void>((resolve) => this.writtenWaiters.push(resolve));
  }

  handleEvent(event: SessionEvent): boolean {
    const bridge = this.active;
    if ((event.type === "disconnected" || event.type === "reconnecting") && (bridge || this.opening)) {
      this.reset(false);
      return false;
    }
    if (!bridge || event.terminalId !== bridge.terminalId) return false;
    if (event.type === "terminal_frame") return true;
    if (event.type === "terminal_closed") {
      this.dropBridge(bridge, false);
      return true;
    }
    return false;
  }

  dispose(): void {
    this.reset(true);
  }

  private async ensureBridge(target: GuidedScrollTarget): Promise<ActiveBridge | null> {
    if (this.active?.session === target.session && this.active.paneId === target.paneId) return this.active;
    if (this.opening?.session === target.session && this.opening.paneId === target.paneId) return this.opening.promise;
    this.reset(true);
    const version = ++this.version;
    const promise = target.session.terminalOpen(target.paneId, target.cols, target.rows, false).then(async (opened) => {
      if (version !== this.version) {
        await target.session.terminalClose(opened.terminalId).catch(() => undefined);
        return null;
      }
      const bridge: ActiveBridge = {
        ...target,
        terminalId: opened.terminalId,
        nextSequence: 1,
        activity: 0,
        tail: Promise.resolve(),
      };
      this.active = bridge;
      return bridge;
    }).finally(() => {
      if (this.opening?.promise === promise) this.opening = null;
    });
    this.opening = { session: target.session, paneId: target.paneId, promise };
    return promise;
  }

  private scheduleIdleRelease(bridge: ActiveBridge): void {
    this.clearIdleTimer();
    this.idleTimer = this.schedule(() => {
      this.idleTimer = null;
      if (this.active === bridge) this.dropBridge(bridge, true);
    }, GUIDED_SCROLL_IDLE_MS);
  }

  private reset(close: boolean): void {
    this.version += 1;
    this.opening = null;
    const bridge = this.active;
    this.active = null;
    this.clearIdleTimer();
    if (bridge && close) this.closeAfterTail(bridge);
  }

  private dropBridge(bridge: ActiveBridge, close: boolean): void {
    if (this.active !== bridge) return;
    this.version += 1;
    this.active = null;
    this.clearIdleTimer();
    if (close) this.closeAfterTail(bridge);
  }

  private closeAfterTail(bridge: ActiveBridge): void {
    void bridge.tail.finally(() => bridge.session.terminalClose(bridge.terminalId)).catch(() => undefined);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    this.cancel(this.idleTimer);
    this.idleTimer = null;
  }
}

export const guidedScrollController = new GuidedScrollController();

// A wheel notch is one of the paths of the session's order: a key pressed after it waits for the bridge to open.
registerLivePath("wheel", {
  unsent: () => guidedScrollController.unsent(),
  written: () => guidedScrollController.written(),
});
