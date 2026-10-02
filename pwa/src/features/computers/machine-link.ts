import { ProtocolError } from "../../lib/protocol/errors";
import type { MachineLinkError, MachineLinkStatus, MachineSummary } from "../../lib/protocol/machine-link";
import type { PairResult } from "../../lib/protocol/pair-ws";
import type { LiveSession } from "../../lib/protocol/session-types";

/**
 * Machine linking — add a machine the connected computer already reaches.
 *
 * The computer starts Pairfob on that machine and relays its one-use pairing
 * link; this device then pairs with the machine directly, so the machine keeps
 * its own identity and nothing is proxied. The connected session is never
 * replaced: a linked machine only joins the catalog.
 *
 * `LinkMachine` is a mutation. It is sent once per tap and never replayed; an
 * unknown outcome surfaces as `lost` and the next tap reads the computer's own
 * job state.
 */

export type MachineLinkStep = "checking" | "installing" | "pairing";
export type MachineLinkFailure = MachineLinkError | "rejected" | "bad_link" | "pairing_failed" | "lost";

export type MachineLinksView = {
  machines: readonly MachineSummary[];
  busy: { machineId: string; step: MachineLinkStep } | null;
  failure: { machineId: string; code: MachineLinkFailure } | null;
};

/** What linking needs from the application; the live wiring is in `actions`. */
export type MachineLinkPorts = {
  session: () => LiveSession | null;
  hostId: () => string | null;
  enabled: () => boolean;
  /** Ask before Pairfob is installed on the machine. */
  confirmInstall: (label: string) => Promise<boolean>;
  /** Pair with the machine from the relayed link; rejects a link for another origin. */
  pair: (pairUrl: string, signal: AbortSignal) => Promise<PairResult>;
  save: (pair: PairResult) => Promise<void>;
  reload: () => Promise<void>;
  announce: (label: string) => void;
  delay: (ms: number) => Promise<void>;
};

const POLL_MS = 800;
const REJECTED = ["conflict", "invalid_argument", "unknown_op", "rate_limited"];

class Stale extends Error {}

export function createMachineLinks(ports: MachineLinkPorts) {
  let view: MachineLinksView = { machines: [], busy: null, failure: null };
  let listedFor: string | null = null;
  let generation = 0;
  let abort: AbortController | null = null;
  let operation: { session: LiveSession; id: string } | null = null;
  const listeners = new Set<() => void>();

  function publish(next: Partial<MachineLinksView>): void {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  }

  async function refresh(): Promise<void> {
    const session = ports.session(), host = ports.hostId();
    if (!session?.listMachines || !host || !ports.enabled()) {
      listedFor = null;
      if (view.machines.length) publish({ machines: [] });
      return;
    }
    if (listedFor !== host && view.machines.length) publish({ machines: [], failure: null });
    try {
      const machines = await session.listMachines();
      if (ports.session() !== session || ports.hostId() !== host) return;
      listedFor = host;
      publish({ machines });
    } catch {
      /* The list is a convenience: an unreadable one leaves the page as it was. */
    }
  }

  function failureCode(error: unknown): MachineLinkFailure {
    if (error instanceof ProtocolError && error.code === "bad_link") return "bad_link";
    if (error instanceof ProtocolError && REJECTED.includes(error.code)) return "rejected";
    return "lost";
  }

  async function link(machineId: string): Promise<void> {
    const session = ports.session(), host = ports.hostId();
    const machine = view.machines.find(item => item.id === machineId);
    if (!session?.linkMachine || !session.linkMachineStatus || !host || !machine || machine.state !== "available" || view.busy) return;
    const attempt = ++generation;
    const owned = () => attempt === generation && ports.session() === session && ports.hostId() === host;
    const step = (next: MachineLinkStep) => {
      if (owned() && view.busy?.step !== next) publish({ busy: { machineId, step: next } });
    };

    /** One LinkMachine, then reads until the computer needs this device or stops. */
    async function start(install: boolean): Promise<MachineLinkStatus> {
      let status = await session!.linkMachine!(machineId, install);
      if (!owned()) throw new Stale();
      operation = { session: session!, id: status.operationId };
      while (status.phase === "checking" || status.phase === "installing") {
        step(status.phase);
        await ports.delay(POLL_MS);
        if (!owned()) throw new Stale();
        const next = await session!.linkMachineStatus!();
        if (!owned()) throw new Stale();
        if (next.operationId !== status.operationId) throw new ProtocolError("lost");
        status = next;
      }
      return status;
    }

    publish({ busy: { machineId, step: "checking" }, failure: null });
    let pairing = false;
    try {
      let status = await start(false);
      if (status.phase === "needs_install") {
        const agreed = await ports.confirmInstall(machine.label);
        if (!owned()) return;
        if (!agreed) {
          publish({ busy: null });
          return;
        }
        status = await start(true);
      }
      if (status.phase !== "offering" || !status.pairUrl) {
        publish({ busy: null, failure: { machineId, code: status.error ?? "internal" } });
        return;
      }
      step("pairing");
      pairing = true;
      abort = new AbortController();
      const pair = await ports.pair(status.pairUrl, abort.signal);
      if (!owned()) return;
      // The machine reports its own hostname on first connect; until then the
      // label the computer knows it by is the only name there is.
      await ports.save({ ...pair, hostname: pair.hostname || machine.label });
      await ports.reload();
      if (!owned()) return;
      operation = null;
      // Mark the row now: the computer's refreshed list is a round trip away,
      // and until it lands the row would offer Add again.
      publish({
        busy: null,
        machines: view.machines.map(item => item.id === machineId ? { ...item, daemonId: pair.daemonId } : item),
      });
      ports.announce(machine.label);
      void refresh();
    } catch (error) {
      if (error instanceof Stale || !owned()) return;
      release();
      const code = failureCode(error);
      publish({ busy: null, failure: { machineId, code: pairing && code !== "bad_link" ? "pairing_failed" : code } });
    } finally {
      if (attempt === generation) {
        abort = null;
        // The session or computer changed under the attempt: nothing above
        // published for it, so clear its row here.
        if (!owned() && (view as MachineLinksView).busy?.machineId === machineId) {
          generation += 1;
          release();
          publish({ busy: null });
        }
      }
    }
  }

  /** Tell the computer to drop the job so the machine's pairing slot closes now. */
  function release(): void {
    const held = operation;
    operation = null;
    if (held?.id) void held.session.linkMachineCancel?.(held.id).catch(() => undefined);
  }

  function cancel(): void {
    if (!view.busy) return;
    generation += 1;
    abort?.abort();
    abort = null;
    release();
    publish({ busy: null });
  }

  return {
    view: () => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    link,
    cancel,
    dismissFailure: () => { if (view.failure) publish({ failure: null }); },
  };
}

export type MachineLinks = ReturnType<typeof createMachineLinks>;
