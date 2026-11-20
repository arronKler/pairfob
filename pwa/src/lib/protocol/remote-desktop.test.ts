import { expect, test } from "bun:test";
import { bindDesktop, readDesktopObservation } from "./remote-desktop";
import type { SessionTransport } from "./session-transport";

test("desktop input and cleanup stay on one direct epoch", async () => {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const direct = {
    kind: "p2p",
    async rpc(op: string, params: Record<string, unknown>) {
      calls.push({ op, params });
      return op === "DesktopOpen" ? { display: "Mac", sdp: "answer", audio: false, control: true } : {};
    },
  } as unknown as SessionTransport;
  let transport = direct;
  const desktop = bindDesktop(() => transport);
  expect(await desktop.open("offer", true, false, "motion")).toEqual({ display: "Mac", sdp: "answer" });
  await desktop.input({ kind: "text", text: "你好" });
  await desktop.input({ kind: "release" });
  const id = calls[0].params.operation_id;
  expect(calls[1].params).toMatchObject({ desktop_id: id, sequence: 1, operation_id: id + "_1" });
  expect(calls[2].params).toMatchObject({ desktop_id: id, sequence: 2, operation_id: id + "_2" });
  transport = { ...direct, kind: "relay" } as SessionTransport;
  expect(() => bindDesktop(() => transport)).toThrow("p2p_required");
  await expect(desktop.ping()).rejects.toThrow("disconnected");
  await expect(desktop.close()).rejects.toThrow("disconnected");
  transport = { ...direct } as SessionTransport;
  await expect(desktop.input({ kind: "release" })).rejects.toThrow("disconnected");
  expect(calls).toHaveLength(3);
});

test("immediate reconnect waits for the previous close receipt on the same direct transport", async () => {
  const calls: string[] = [];
  let released!: () => void;
  const transport = {
    kind: "p2p",
    async rpc(op: string) {
      calls.push(op);
      if (op === "DesktopClose") await new Promise<void>(resolve => { released = resolve; });
      return { sdp: "answer", display: "Mac", control: false, audio: false };
    },
  };
  const first = bindDesktop(() => transport);
  await first.open("offer1", false, false, "motion");
  const stopped = first.close();
  const next = bindDesktop(() => transport).open("offer2", false, false, "motion");
  expect(calls).toEqual(["DesktopOpen", "DesktopClose"]);
  released();
  await Promise.all([stopped, next]);
  expect(calls).toEqual(["DesktopOpen", "DesktopClose", "DesktopOpen"]);
});

test("desktop heartbeat negotiates observation with zero-safe RTP timestamps", async () => {
  const calls: object[] = [];
  const direct = { kind: "p2p", async rpc(_: string, args: object) {
    calls.push(args);
    return calls.length === 1 ? {} : { rtp_time: 0, healthy: true, encode_ms: 2.25 };
  } };
  const desktop = bindDesktop(() => direct);
  expect(await desktop.ping()).toBeUndefined();
  expect(await desktop.ping(true, true)).toEqual({ rtp_time: 0, healthy: true, encode_ms: 2.25 });
  expect(Object.keys(calls[0])).toEqual(["desktop_id"]);
  expect(calls[1]).toMatchObject({ observe: true, keyframe: true });
  expect(() => readDesktopObservation({ rtp_time: -1, healthy: true })).toThrow("bad_response");
});
