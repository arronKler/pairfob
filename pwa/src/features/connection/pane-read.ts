/**
 * Pane-read lane: one in-flight read, one replaceable queued request.
 *
 * The flight reserves its real eventual result before any setBusy/perform
 * callback can reenter: a same-owner request during perform shares the actual
 * observation, a setBusy subscriber requesting another pane queues instead of
 * starting a second read, and a synchronous perform throw retires only the
 * flight it created. The owner tuple is detached at scheduling, so a caller
 * mutating its owner object cannot retarget an in-flight read. Finalizers
 * ignore completions that are no longer the current flight, and only the
 * finalizer that owns the flight settles or clears it. A reset invalidates
 * every handoff captured before it — even one it cannot see (a queued request
 * already carried into the completion publication), so a retired
 * continuation never restarts.
 */
import type { LiveSession } from "../../lib/protocol/session-types";
import type { PaneReadObservation, PaneRefreshRequest } from "./refresh-request";

export type PaneReadOwner = {
  session: LiveSession;
  viewVersion: number;
  paneId: string;
  incarnation: number;
  mode: "guided" | "agent" | "full";
};

export type PaneReadFlight = PaneReadOwner & {
  startedAt: number;
  promise: Promise<PaneReadObservation | null>;
  settle: (observation: PaneReadObservation | null) => void;
};

export type QueuedPaneRead = PaneReadOwner & {
  postponeFallback: boolean;
  promise: Promise<PaneReadObservation | null>;
  resolve: (observation: PaneReadObservation | null) => void;
};

export type PaneReadLanePorts = {
  perform(owner: PaneReadOwner, startedAt: number): Promise<PaneReadObservation | null>;
  deferPane(): void;
  setBusy(busy: boolean): void;
  setPending(pending: boolean): void;
  now(): number;
};

function sameOwner(left: PaneReadOwner, right: PaneReadOwner): boolean {
  return left.session === right.session &&
    left.viewVersion === right.viewVersion &&
    left.paneId === right.paneId &&
    left.incarnation === right.incarnation &&
    left.mode === right.mode;
}

/** One owned immutable tuple for scheduling and execution; the caller's object stays its own. */
function detachOwner(owner: PaneReadOwner): PaneReadOwner {
  return {
    session: owner.session,
    viewVersion: owner.viewVersion,
    paneId: owner.paneId,
    incarnation: owner.incarnation,
    mode: owner.mode,
  };
}

export function createPaneReadLane(ports: PaneReadLanePorts) {
  let paneReadFlight: PaneReadFlight | null = null;
  let queuedPaneRead: QueuedPaneRead | null = null;
  // Bumped by reset: a queued request already carried into the completion
  // publication is invisible to reset, so the finalizer re-checks this epoch
  // before continuing and retires a pre-reset handoff without restarting it.
  let handoffEpoch = 0;

  function startPaneRead(input: PaneReadOwner): Promise<PaneReadObservation | null> {
    const owner = detachOwner(input);
    const startedAt = ports.now();
    let settle!: (observation: PaneReadObservation | null) => void;
    const promise = new Promise<PaneReadObservation | null>((resolve) => {
      settle = resolve;
    });
    const flight: PaneReadFlight = { ...owner, startedAt, promise, settle };
    // Reserve the real deferred result before any foreign callback: a setBusy
    // subscriber or a reentrant perform sees this flight, never a placeholder.
    paneReadFlight = flight;
    ports.setBusy(true);
    // setBusy can reenter and retire this lane (reset): a retired flight must
    // not invoke perform at all, and its deferred result stays settled null.
    if (paneReadFlight !== flight) {
      flight.settle(null);
      return promise;
    }
    let result: Promise<PaneReadObservation | null>;
    try {
      result = ports.perform(owner, startedAt);
    } catch (error) {
      // A synchronous perform failure retires only the flight it created (the
      // lane is not wedged and queued work still runs), then surfaces to the
      // caller that requested this read.
      finishPaneRead(flight, null);
      throw error;
    }
    result.then(
      (observation) => finishPaneRead(flight, observation),
      () => finishPaneRead(flight, null),
    );
    return promise;
  }

  function finishPaneRead(flight: PaneReadFlight, observation: PaneReadObservation | null): void {
    if (paneReadFlight !== flight) return;
    const queued = queuedPaneRead;
    const epoch = handoffEpoch;
    queuedPaneRead = null;
    paneReadFlight = null;
    flight.settle(observation);
    ports.setBusy(false);
    ports.setPending(false);
    if (!queued) return;
    continueAfterFinish(queued, epoch);
  }

  function continueAfterFinish(queued: QueuedPaneRead, epoch: number): void {
    if (paneReadFlight) {
      // A subscriber started a newer flight during the busy/pending completion
      // publication. The queued request this finalizer carried is no longer
      // the lane's handoff: a newer queued request must keep its priority and
      // its actual promise, so retire the old one instead of displacing it.
      queued.resolve(null);
      return;
    }
    if (epoch !== handoffEpoch) {
      // A reset during the completion publication invalidated this handoff,
      // which reset could not see once carried. Settle its actual promise
      // without restarting the retired request.
      queued.resolve(null);
      return;
    }
    const next = startPaneRead(queued);
    void next.then(
      (observation) => {
        if (queued.postponeFallback && observation) ports.deferPane();
        queued.resolve(observation);
      },
      () => queued.resolve(null),
    );
  }

  function queuePaneRead(
    owner: PaneReadOwner,
    request: PaneRefreshRequest,
  ): Promise<PaneReadObservation | null> {
    const owned = detachOwner(owner);
    const queued = queuedPaneRead;
    if (queued && !sameOwner(queued, owned)) {
      queued.resolve(null);
      queuedPaneRead = null;
    }
    if (queuedPaneRead) {
      queuedPaneRead.postponeFallback ||= request.postponeFallback === true;
      return queuedPaneRead.promise;
    }
    let resolve!: (observation: PaneReadObservation | null) => void;
    const promise = new Promise<PaneReadObservation | null>((done) => {
      resolve = done;
    });
    queuedPaneRead = {
      ...owned,
      postponeFallback: request.postponeFallback === true,
      promise,
      resolve,
    };
    ports.setPending(true);
    return promise;
  }

  function postponeFallback(
    promise: Promise<PaneReadObservation | null>,
    enabled: boolean,
  ): Promise<PaneReadObservation | null> {
    if (!enabled) return promise;
    return promise.then((observation) => {
      if (observation) ports.deferPane();
      return observation;
    });
  }

  return {
    reset(): void {
      handoffEpoch += 1;
      const flight = paneReadFlight;
      paneReadFlight = null;
      flight?.settle(null);
      queuedPaneRead?.resolve(null);
      queuedPaneRead = null;
      ports.setBusy(false);
      ports.setPending(false);
    },
    request(owner: PaneReadOwner, request: PaneRefreshRequest): Promise<PaneReadObservation | null> {
      const notBefore = request.notBefore ?? 0;
      if (paneReadFlight) {
        const reusable = sameOwner(paneReadFlight, owner) && paneReadFlight.startedAt >= notBefore;
        if (reusable) return postponeFallback(paneReadFlight.promise, request.postponeFallback === true);
        return queuePaneRead(owner, request);
      }
      return postponeFallback(startPaneRead(owner), request.postponeFallback === true);
    },
  };
}
