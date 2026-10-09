import { showError, showStatus } from "../../../app/notices-store";
import { t } from "../../../lib/i18n";
import { haptic } from "../../../lib/dom";
import { herdLiveness } from "../../connection/runtime-status";
import { connectionStore } from "../../connection/connection-store";
import { dashboardStore, liveAgents } from "../../dashboard/catalog-store";
import { openPaneId, sessionStore } from "../session-store";

/**
 * Stop a working agent from the send button (session page v2).
 *
 * Two steps, each judged only by Herdr's own status for the pane, never by
 * reading the screen: a tap sends Esc and watches the status; if the pane is
 * still working after the watch window the button offers a force stop, which
 * sends Ctrl+C exactly once and watches again. Ctrl+C is never sent without
 * that second, deliberate tap, because several agents exit on a repeated one.
 *
 * Leaving the pane, or losing the ability to confirm its status, cancels the
 * flow: a verdict drawn from a stale status would be a guess.
 */
export type StopPhase = "idle" | "stopping" | "stuck" | "forcing";
export type StopKey = "esc" | "ctrl+c";

export type StopSnapshot = Readonly<{ phase: StopPhase; paneId: string }>;

export type StopTarget = {
  paneId: string;
  /** The surface's normal key path (guided key queue, agent chat SendKeys, terminal bytes). */
  sendKey: (key: StopKey) => void | Promise<void>;
};

export type StopOutcome = "stopped" | "stuck" | "failed";

export type StopFlowPorts = {
  /** true = working, false = left working, null = cannot be confirmed. */
  working: (paneId: string) => boolean | null;
  ownerActive: (paneId: string) => boolean;
  /** Re-run `observe` whenever the status or the owner may have changed. */
  watch: (onChange: () => void) => () => void;
  schedule: (run: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  report: (outcome: StopOutcome) => void;
  onChange: () => void;
};

export const STOP_WATCH_MS = 4_000;

const IDLE: StopSnapshot = { phase: "idle", paneId: "" };

export class StopFlow {
  private state: StopSnapshot = IDLE;
  private target: StopTarget | null = null;
  private deadline: unknown = null;
  private unwatch: (() => void) | null = null;
  private attempt = 0;

  constructor(private readonly ports: StopFlowPorts) {}

  snapshot(): StopSnapshot {
    return this.state;
  }

  /** First tap (or long press): send Esc and watch. */
  start(target: StopTarget): void {
    if (this.state.phase !== "idle" && this.state.phase !== "stuck") return;
    if (this.state.phase === "stuck" && this.state.paneId === target.paneId) {
      this.force();
      return;
    }
    if (this.ports.working(target.paneId) !== true) return;
    this.reset();
    this.target = target;
    this.send("esc", "stopping");
  }

  /** Second, deliberate tap after the first step did not stop the pane. */
  force(): void {
    if (this.state.phase !== "stuck" || !this.target) return;
    this.send("ctrl+c", "forcing");
  }

  cancel(): void {
    if (this.state.phase === "idle") return;
    this.reset();
    this.ports.onChange();
  }

  /** Status or owner changed: settle as soon as the pane leaves working. */
  observe(): void {
    const target = this.target;
    if (!target || this.state.phase === "idle") return;
    if (!this.ports.ownerActive(target.paneId)) {
      this.cancel();
      return;
    }
    const working = this.ports.working(target.paneId);
    if (working === null) {
      this.cancel();
      return;
    }
    if (working) return;
    this.reset();
    this.ports.report("stopped");
    this.ports.onChange();
  }

  private send(key: StopKey, phase: "stopping" | "forcing"): void {
    const target = this.target!;
    const attempt = ++this.attempt;
    this.clearDeadline();
    this.state = { phase, paneId: target.paneId };
    this.unwatch ??= this.ports.watch(() => this.observe());
    this.ports.onChange();
    let sent: void | Promise<void>;
    try {
      sent = target.sendKey(key);
    } catch {
      this.cancel();
      return;
    }
    // A key that never reached the pane cannot have stopped it; the key path
    // already reported why.
    void Promise.resolve(sent).catch(() => {
      if (this.attempt === attempt) this.cancel();
    });
    this.deadline = this.ports.schedule(() => this.expire(attempt), STOP_WATCH_MS);
  }

  private expire(attempt: number): void {
    if (attempt !== this.attempt) return;
    this.deadline = null;
    this.observe();
    if (this.state.phase === "stopping") {
      this.state = { phase: "stuck", paneId: this.state.paneId };
      this.ports.report("stuck");
      this.ports.onChange();
    } else if (this.state.phase === "forcing") {
      this.reset();
      this.ports.report("failed");
      this.ports.onChange();
    }
  }

  private clearDeadline(): void {
    if (this.deadline !== null) this.ports.cancel(this.deadline);
    this.deadline = null;
  }

  private reset(): void {
    this.attempt++;
    this.clearDeadline();
    this.unwatch?.();
    this.unwatch = null;
    this.target = null;
    this.state = IDLE;
  }
}

/** Herdr's status for a pane, or null while the connection cannot confirm it. */
function paneWorking(paneId: string): boolean | null {
  if (herdLiveness() !== "live") return null;
  const agent = liveAgents().find((card) => card.paneId === paneId);
  return agent ? agent.status === "working" : null;
}

const stopListeners = new Set<() => void>();

const flow = new StopFlow({
  working: paneWorking,
  ownerActive: (paneId) => openPaneId() === paneId,
  watch: (onChange) => {
    const unsubs = [dashboardStore.subscribe(onChange), sessionStore.subscribe(onChange), connectionStore.subscribe(onChange)];
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  },
  schedule: (run, ms) => window.setTimeout(run, ms),
  cancel: (handle) => window.clearTimeout(handle as number),
  report: (outcome) => {
    if (outcome === "stopped") showStatus(t("compose2.stopped"));
    else if (outcome === "stuck") showStatus(t("compose2.stillRunning"));
    else showError(t("compose2.stopFailed"));
  },
  onChange: () => {
    for (const listener of stopListeners) listener();
  },
});

export function stopSnapshot(): StopSnapshot {
  return flow.snapshot();
}

export function subscribeStop(listener: () => void): () => void {
  stopListeners.add(listener);
  return () => { stopListeners.delete(listener); };
}

/** The flow's phase for this pane; another pane's leftover state reads as idle. */
export function stopPhaseFor(snapshot: StopSnapshot, paneId: string): StopPhase {
  return snapshot.paneId === paneId ? snapshot.phase : "idle";
}

export function startStop(target: StopTarget): void {
  haptic(10);
  flow.start(target);
}

export function forceStop(): void {
  haptic(14);
  flow.force();
}

export function cancelStop(): void {
  flow.cancel();
}

/**
 * The send button's one decision, shared by guided, agent chat and full
 * terminal compose. Stop is offered only for an empty message on a pane Herdr
 * reports as working; typed text keeps the button a send button (long press
 * still stops).
 */
export type SendKind = "enter" | "send" | "busy" | "wait" | "stop" | "stopping" | "force";

export type SendInput = {
  hasText: boolean;
  ready: number;
  /**
   * Attachments still uploading or waiting on the reader. They are part of the
   * message too: with any in the tray the button sends (and waits), never stops.
   */
  unfinished?: number;
  submitting: boolean;
  waiting: boolean;
  /** Live input typed on glass: the button is the field's Enter key and never turns into stop. */
  live: boolean;
  /** `canInterruptAgent(status)` for the open pane. */
  working: boolean;
  stop: StopPhase;
};

export function sendKind(input: SendInput): SendKind {
  if (input.waiting) return "wait";
  if (input.stop === "stopping" || input.stop === "forcing") return "stopping";
  if (input.stop === "stuck" && input.working) return "force";
  if (input.submitting) return "busy";
  const content = input.hasText || input.ready > 0 || (input.unfinished ?? 0) > 0;
  if (content) return "send";
  if (input.working && !input.live) return "stop";
  return "enter";
}
