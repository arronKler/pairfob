import { describe, expect, test } from "bun:test";
import { ProtocolError } from "../../lib/protocol/errors";
import type { MachineLinkStatus, MachineSummary } from "../../lib/protocol/machine-link";
import type { PairResult } from "../../lib/protocol/pair-ws";
import type { LiveSession } from "../../lib/protocol/session-types";
import { createMachineLinks, type MachineLinkPorts } from "./machine-link";

const BUILD: MachineSummary = { id: "m1", label: "Build machine", state: "available" };
const PAIR = { deviceId: "dev_1", daemonId: "d_84e96fc860788018e276", label: "iPhone" } as PairResult;

/** A computer whose link job walks a scripted list of statuses. */
function harness(script: { first: MachineLinkStatus[]; install?: MachineLinkStatus[] }, overrides: Partial<MachineLinkPorts> = {}) {
  const calls: string[] = [];
  const saved: PairResult[] = [];
  let queue: MachineLinkStatus[] = [];
  let operation = 0;
  const status = (phase: MachineLinkStatus["phase"], extra: Partial<MachineLinkStatus> = {}): MachineLinkStatus =>
    ({ operationId: `op_${operation}`, machineId: "m1", phase, ...extra });
  const session = {
    listMachines: async () => { calls.push("list"); return [BUILD]; },
    linkMachine: async (machineId: string, install: boolean) => {
      operation += 1;
      calls.push(`link:${machineId}:${install}`);
      queue = (install ? script.install! : script.first).map(item => ({ ...item, operationId: `op_${operation}` }));
      return status("checking");
    },
    linkMachineStatus: async () => { calls.push("status"); return queue.shift() ?? status("failed", { error: "internal" }); },
    linkMachineCancel: async (operationId: string) => { calls.push(`cancel:${operationId}`); return status("failed", { error: "cancelled" }); },
  } as unknown as LiveSession;
  const world = { session: session as LiveSession | null, host: "d_host" as string | null };
  const ports: MachineLinkPorts = {
    session: () => world.session,
    hostId: () => world.host,
    enabled: () => true,
    confirmInstall: async () => { calls.push("confirm"); return true; },
    pair: async pairUrl => { calls.push(`pair:${pairUrl}`); return PAIR; },
    save: async pair => { saved.push(pair); },
    reload: async () => { calls.push("reload"); },
    announce: label => { calls.push(`announce:${label}`); },
    delay: async () => undefined,
    ...overrides,
  };
  return { links: createMachineLinks(ports), calls, saved, world };
}

const offering = { operationId: "", machineId: "m1", phase: "offering", pairUrl: "https://pairfob.com/pair#x" } as MachineLinkStatus;
const step = (phase: MachineLinkStatus["phase"], extra: Partial<MachineLinkStatus> = {}) =>
  ({ operationId: "", machineId: "m1", phase, ...extra }) as MachineLinkStatus;

describe("machine linking", () => {
  test("adds a machine that already runs Pairfob without asking to install", async () => {
    const { links, calls, saved } = harness({ first: [offering] });
    await links.refresh();
    await links.link("m1");
    expect(calls).toEqual(["list", "link:m1:false", "status", "pair:https://pairfob.com/pair#x", "reload", "announce:Build machine", "list"]);
    expect(saved).toEqual([{ ...PAIR, hostname: "Build machine" }]);
    expect(links.view()).toMatchObject({ busy: null, failure: null });
  });

  test("installs only after the user agrees, with a second single request", async () => {
    const declined = harness({ first: [step("needs_install")], install: [offering] }, { confirmInstall: async () => false });
    await declined.links.refresh();
    await declined.links.link("m1");
    expect(declined.calls.filter(call => call.startsWith("link:"))).toEqual(["link:m1:false"]);
    expect(declined.links.view()).toMatchObject({ busy: null, failure: null });

    const agreed = harness({ first: [step("needs_install")], install: [step("installing"), step("installing"), offering] });
    await agreed.links.refresh();
    const steps: string[] = [];
    agreed.links.subscribe(() => { const busy = agreed.links.view().busy; if (busy && steps.at(-1) !== busy.step) steps.push(busy.step); });
    await agreed.links.link("m1");
    expect(agreed.calls.filter(call => call.startsWith("link:") || call === "confirm")).toEqual(["link:m1:false", "confirm", "link:m1:true"]);
    expect(steps).toEqual(["checking", "installing", "pairing"]);
    expect(agreed.saved).toHaveLength(1);
  });

  test("reports the computer's failure code and saves nothing", async () => {
    const { links, calls, saved } = harness({ first: [step("failed", { error: "unreachable" })] });
    await links.refresh();
    await links.link("m1");
    expect(links.view()).toMatchObject({ busy: null, failure: { machineId: "m1", code: "unreachable" } });
    expect(saved).toEqual([]);
    expect(calls.some(call => call.startsWith("pair:"))).toBe(false);
  });

  test("a refused or failed pairing releases the machine's slot and never retries the request", async () => {
    for (const [error, code] of [[new ProtocolError("bad_link"), "bad_link"], [new ProtocolError("bad_pair_code"), "pairing_failed"]] as const) {
      const { links, calls, saved } = harness({ first: [offering] }, { pair: async () => { throw error; } });
      await links.refresh();
      await links.link("m1");
      expect(links.view().failure).toEqual({ machineId: "m1", code });
      expect(calls.filter(call => call.startsWith("link:"))).toEqual(["link:m1:false"]);
      expect(calls).toContain("cancel:op_1");
      expect(saved).toEqual([]);
    }
  });

  test("a request the computer rejects is not confused with an unknown outcome", async () => {
    for (const [error, code] of [[new ProtocolError("conflict"), "rejected"], [new ProtocolError("timeout"), "lost"]] as const) {
      const { links, world } = harness({ first: [offering] });
      (world.session as unknown as { linkMachine: unknown }).linkMachine = async () => { throw error; };
      await links.refresh();
      await links.link("m1");
      expect(links.view().failure).toEqual({ machineId: "m1", code });
    }
  });

  test("cancel stops the job on the computer and a late pairing is dropped", async () => {
    let finishPairing: (pair: PairResult) => void = () => undefined;
    const { links, calls, saved } = harness({ first: [offering] }, {
      pair: (_url, signal) => new Promise<PairResult>((resolve, reject) => {
        finishPairing = resolve;
        signal.addEventListener("abort", () => reject(new ProtocolError("pairing_cancelled")));
      }),
    });
    await links.refresh();
    const linking = links.link("m1");
    while (links.view().busy?.step !== "pairing") await Promise.resolve();
    links.cancel();
    finishPairing(PAIR);
    await linking;
    expect(links.view()).toMatchObject({ busy: null, failure: null });
    expect(calls).toContain("cancel:op_1");
    expect(saved).toEqual([]);
  });

  test("switching computers drops an in-flight link and clears the other computer's machines", async () => {
    const { links, saved, world } = harness({ first: [step("checking"), offering] }, {
      delay: async () => { world.host = "d_other"; },
    });
    await links.refresh();
    await links.link("m1");
    expect(saved).toEqual([]);
    expect(links.view().busy).toBeNull();
    world.session = null;
    await links.refresh();
    expect(links.view().machines).toEqual([]);
  });

  test("ignores machines that cannot be added and a second tap while busy", async () => {
    const { links, calls } = harness({ first: [offering] });
    await links.link("m1");
    expect(calls).toEqual([]);
    await links.refresh();
    await links.link("nope");
    expect(calls).toEqual(["list"]);
  });
});
