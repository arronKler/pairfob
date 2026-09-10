import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Direction, DIR_C, DIR_S } from "./aead.ts";
import { DataFrameChannel } from "./data-channel.ts";
import { watchPageVisibility } from "./page-activity.ts";
import { Typ, type Frame } from "./envelope.ts";
import type { FrameChannel } from "./frame-channel.ts";
import { ProtocolError } from "./errors.ts";
import { SessionTransport } from "./session-transport.ts";
import { DirectSessionDriver, type DirectSessionHost } from "./session-direct.ts";

const realm = new Window();

class Page extends realm.EventTarget {
  visibilityState = "visible";
  show(hidden: boolean): void {
    this.visibilityState = hidden ? "hidden" : "visible";
    this.dispatchEvent(new realm.Event("visibilitychange"));
  }
}
class Channel implements FrameChannel {
  readonly kind = "p2p" as const;
  sent: Frame[] = [];
  closed = false;
  handler: (frame: Frame) => void = () => undefined;
  send(frame: Frame): void { this.sent.push(frame); }
  close(): void { this.closed = true; }
  use(handler: (frame: Frame) => void): void { this.handler = handler; }
  onClose(): () => void { return () => undefined; }
  async next(): Promise<Frame> { throw new Error("unused"); }
}
let page: Page;
let documentDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  page = new Page();
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
});
afterEach(() => {
  if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
  else Reflect.deleteProperty(globalThis, "document");
});

function transport(channel: FrameChannel): SessionTransport {
  const key = new Uint8Array(32).fill(1);
  const sid = new Uint8Array(16).fill(2);
  return new SessionTransport(channel, sid, new Direction(key, DIR_C), new Direction(key, DIR_S), () => undefined);
}

describe("foreground heartbeat recovery", () => {
  test("background time and queued PONG do not destroy the existing transport", () => {
    let beat = () => undefined;
    let now = 0;
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => { beat = fn; return 1; }) as typeof setInterval);
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const channel = new Channel();
    const session = transport(channel);
    try {
      const ping = channel.sent[0]!;
      page.show(true);
      now = 120_000;
      beat();
      expect(channel.closed).toBe(false);
      expect(channel.sent).toHaveLength(1);
      page.show(false);
      beat(); // Timers can run before the queued PONG after suspension.
      expect(channel.closed).toBe(false);
      channel.handler({ ...ping, typ: Typ.PONG });
      now += 25_000;
      beat();
      expect(channel.closed).toBe(false);
      expect(channel.sent).toHaveLength(2);
      now += 25_000;
      beat(); // A real unresponsive foreground connection still fails.
      expect(channel.closed).toBe(true);
    } finally {
      session.close(); interval.mockRestore(); clock.mockRestore();
    }
  });

  test("an invalid queued PONG still fails closed", () => {
    const channel = new Channel();
    const session = transport(channel);
    page.show(true);
    page.show(false);
    channel.handler({ ...channel.sent[0]!, typ: Typ.PONG, payload: new Uint8Array(8).fill(99) });
    expect(channel.closed).toBe(true);
    session.close();
  });
});

function driverFixture() {
  const calls: Array<{ timeout: number | undefined; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const failures: ProtocolError[] = [];
  const session = {
    kind: "p2p",
    diagnose: () => undefined,
    directChannel: () => ({ iceDisconnected: () => true }),
    rpc: (_op: string, _params: unknown, timeout?: number) => new Promise((resolve, reject) => calls.push({ timeout, resolve, reject })),
    suspend: (error: ProtocolError) => failures.push(error),
  } as unknown as SessionTransport;
  const events: string[] = [];
  const host = { getTransport: () => session, emit: (event: { type: string }) => events.push(event.type) } as DirectSessionHost;
  const driver = new DirectSessionDriver(host);
  const visibility = () => driver.setPageHidden(page.visibilityState === "hidden");
  page.addEventListener("visibilitychange", visibility);
  return { driver, session, calls, failures, events, host };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("foreground P2P probes", () => {
  test("duplicate resume events share one 8s probe even while ICE is disconnected", async () => {
    const f = driverFixture();
    page.show(true);
    f.driver.probe(f.session, "probe");
    expect(f.calls).toHaveLength(0);
    page.show(false);
    f.driver.probe(f.session, "probe");
    f.driver.probe(f.session, "probe");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.timeout).toBe(8_000);
    expect(f.events).toEqual(["checking"]);
    f.calls[0]!.resolve({});
    await settle();
    expect(f.failures).toHaveLength(0);
    expect(f.events).toEqual(["checking", "connected"]);
    f.driver.dispose();
  });

  test("a failed foreground probe falls back after the bounded budget", async () => {
    const f = driverFixture();
    f.driver.probe(f.session, "probe");
    f.calls[0]!.reject(new ProtocolError("timeout", "test"));
    await settle();
    expect(f.failures).toHaveLength(1);
    expect(f.failures[0]!.diagnostics?.reason).toBe("foreground_probe_failed");
    f.driver.dispose();
  });

  test("a probe from an earlier foreground cannot tear down the resumed connection", async () => {
    const f = driverFixture();
    f.driver.probe(f.session, "probe");
    page.show(true);
    page.show(false);
    f.driver.probe(f.session, "probe");
    f.calls[0]!.reject(new ProtocolError("timeout", "old"));
    await settle();
    expect(f.failures).toHaveLength(0);
    f.driver.probe(f.session, "probe");
    expect(f.calls).toHaveLength(2);
    f.calls[1]!.resolve({});
    await settle();
    f.driver.dispose();
  });
});


describe("probe readiness ownership", () => {
  test("an old success cannot mark a later foreground ready", async () => {
    const f = driverFixture();
    f.driver.probe(f.session, "probe");
    page.show(true);
    page.show(false);
    f.driver.probe(f.session, "probe");
    f.calls[0]!.resolve({});
    await settle();
    expect(f.events).toEqual(["checking", "checking"]);
    f.calls[1]!.resolve({});
    await settle();
    expect(f.events.at(-1)).toBe("connected");
    f.driver.dispose();
  });

  test("disposing a probe suppresses its late success", async () => {
    const f = driverFixture();
    f.driver.probe(f.session, "probe");
    f.driver.dispose();
    f.calls[0]!.resolve({});
    await settle();
    expect(f.events).toEqual(["checking"]);
  });

  test("relay recovery also waits for a fresh response", async () => {
    const f = driverFixture();
    Object.assign(f.session, { kind: "relay" });
    Object.assign(f.host, { options: {}, networkAvailable: true });
    f.driver.probe(f.session, "probe");
    expect(f.events).toEqual(["checking"]);
    f.calls[0]!.resolve({});
    await settle();
    expect(f.events).toEqual(["checking", "connected"]);
    f.driver.dispose();
  });
});

describe("background direct recovery", () => {
  test("an ICE restart finishing in a later activity cannot disconnect the session", async () => {
    const f = driverFixture();
    let finish!: (result: "failed") => void;
    const internals = f.driver as unknown as {
      maybeRestart: () => Promise<"failed">;
      recoverDirectPath: (transport: SessionTransport) => Promise<void>;
    };
    internals.maybeRestart = () => new Promise((resolve) => { finish = resolve; });
    const recovering = internals.recoverDirectPath(f.session);
    page.show(true);
    page.show(false);
    finish("failed");
    await recovering;
    expect(f.failures).toHaveLength(0);
    f.driver.dispose();
  });

  test("hiding cancels the retry timer and hidden relay readiness cannot start an upgrade", () => {
    const f = driverFixture();
    const internals = f.driver as unknown as {
      directRetryTimer: ReturnType<typeof setTimeout> | null;
      canAutoUpgrade: (transport: SessionTransport) => boolean;
    };
    internals.directRetryTimer = setTimeout(() => { throw new Error("background retry"); }, 10_000);
    page.show(true);
    expect(internals.directRetryTimer).toBeNull();
    expect(internals.canAutoUpgrade(f.session)).toBe(false);
    f.driver.dispose();
  });
});


describe("transport lifecycle integration", () => {
  test("duplicate visible events preserve the ICE resume timer and page pause", () => {
    const peer = Object.assign(new realm.EventTarget(), {
      iceConnectionState: "connected",
      connectionState: "connected",
      close() { this.connectionState = "closed"; },
    });
    const rtc = Object.assign(new realm.EventTarget(), {
      readyState: "open", bufferedAmount: 0, binaryType: "arraybuffer",
      send() {}, close() { this.readyState = "closed"; },
    });
    const link = new DataFrameChannel(rtc as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection);
    const session = transport(link);
    let resume = () => undefined;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { resume = fn; return 123; }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    try {
      page.show(true);
      peer.iceConnectionState = "failed";
      peer.dispatchEvent(new realm.Event("iceconnectionstatechange"));
      expect(rtc.readyState).toBe("open");
      page.show(false);
      page.show(false);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledTimes(0);
      expect(rtc.readyState).toBe("open");
      resume();
      expect(rtc.readyState).toBe("closed");
    } finally {
      session.close(); timeout.mockRestore(); clear.mockRestore();
    }
  });

  test("session visibility handling supplies the probe skipped by an earlier main listener", async () => {
    let f: ReturnType<typeof driverFixture>;
    // main.ts registers before a live session exists.
    page.addEventListener("visibilitychange", () => {
      if (page.visibilityState === "visible") f.driver.probe(f.session, "probe");
    });
    f = driverFixture();
    const unwatch = watchPageVisibility((hidden) => {
      f.driver.setPageHidden(hidden);
      if (!hidden) f.driver.probe(f.session, "probe");
    });
    page.show(true);
    page.show(false);
    expect(f.calls).toHaveLength(1);
    f.calls[0]!.resolve({});
    await settle();
    unwatch();
    f.driver.dispose();
  });
});


describe("network-change probe ordering", () => {
  function fixture() {
    const f = driverFixture();
    let finish!: (result: "ok" | "failed") => void;
    let restarts = 0;
    const internals = f.driver as unknown as { maybeRestart: () => Promise<"ok" | "failed"> };
    internals.maybeRestart = () => {
      restarts++;
      return new Promise(resolve => { finish = resolve; });
    };
    return { ...f, restarts: () => restarts, finish: (result: "ok" | "failed") => finish(result) };
  }

  for (const order of [["path", "probe"], ["probe", "path"]] as const) {
    test(`healthy connection responds immediately with ${order[0]} first`, async () => {
      const f = fixture();
      try {
        page.show(true); page.show(false);
        for (const reason of order) f.driver.probe(f.session, reason);
        expect(f.calls).toHaveLength(1);
        expect(f.restarts()).toBe(0);
        f.calls[0]!.resolve({});
        await settle();
        expect(f.events).toEqual(["checking", "connected"]);
        expect(f.restarts()).toBe(0);
        expect(f.failures).toHaveLength(0);
      } finally { f.driver.dispose(); }
    });
  }

  test("failed path probe repairs once and requires a fresh Ping before connected", async () => {
    const f = fixture();
    try {
      f.driver.probe(f.session, "path");
      f.calls[0]!.reject(new ProtocolError("timeout", "test"));
      await settle();
      expect(f.restarts()).toBe(1);
      f.driver.probe(f.session, "probe");
      expect(f.calls).toHaveLength(1);
      f.finish("ok");
      await settle();
      expect(f.calls).toHaveLength(2);
      expect(f.events).toEqual(["checking"]);
      f.calls[1]!.resolve({});
      await settle();
      expect(f.events).toEqual(["checking", "connected"]);
      expect(f.failures).toHaveLength(0);
    } finally { f.driver.dispose(); }
  });

  for (const stage of ["repair", "confirmation"] as const) {
    test(`${stage} failure falls back without marking connected`, async () => {
      const f = fixture();
      try {
        f.driver.probe(f.session, "path");
        f.calls[0]!.reject(new ProtocolError("timeout", "first probe"));
        await settle();
        f.finish(stage === "repair" ? "failed" : "ok");
        await settle();
        if (stage === "confirmation") {
          f.calls[1]!.reject(new ProtocolError("timeout", "second probe"));
          await settle();
        }
        expect(f.events).toEqual(["checking"]);
        expect(f.failures).toHaveLength(1);
      } finally { f.driver.dispose(); }
    });
  }

  for (const result of ["ok", "failed"] as const) {
    test(`old ${result} repair cannot affect a later foreground`, async () => {
      const f = fixture();
      try {
        f.driver.probe(f.session, "path");
        f.calls[0]!.reject(new ProtocolError("timeout", "old probe"));
        await settle();
        page.show(true); page.show(false);
        f.driver.probe(f.session, "probe");
        f.calls[1]!.resolve({});
        await settle();
        const events = [...f.events];
        f.finish(result);
        await settle();
        expect(f.events).toEqual(events);
        expect(f.events.at(-1)).toBe("connected");
        expect(f.calls).toHaveLength(2);
        expect(f.failures).toHaveLength(0);
      } finally { f.driver.dispose(); }
    });
  }
});


test("a failed path probe joins an in-flight repair despite the restart throttle", async () => {
  const f = driverFixture();
  Object.assign(f.host, { networkAvailable: true, networkMode: "auto" });
  let finish!: (result: "ok") => void;
  const promise = new Promise<"ok">(resolve => { finish = resolve; });
  const internals = f.driver as unknown as {
    restartAttempt: { transport: SessionTransport; promise: Promise<"ok"> };
    restartAbort: AbortController;
    lastRestartAt: number;
  };
  internals.restartAttempt = { transport: f.session, promise };
  internals.restartAbort = new AbortController();
  internals.lastRestartAt = Date.now();
  try {
    f.driver.probe(f.session, "path");
    f.calls[0]!.reject(new ProtocolError("timeout", "repair still running"));
    await settle();
    expect(f.failures).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
    finish("ok");
    await settle();
    expect(f.calls).toHaveLength(2);
    expect(f.events).toEqual(["checking"]);
    f.calls[1]!.resolve({});
    await settle();
    expect(f.events).toEqual(["checking", "connected"]);
    expect(f.failures).toHaveLength(0);
  } finally { f.driver.dispose(); finish("ok"); }
});
