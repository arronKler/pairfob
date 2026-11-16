import { describe, expect, test } from "bun:test";
import { Typ } from "./envelope.ts";
import { observeClose, observeRelayFrame, RELAY_FRAME_SAMPLE_INTERVAL, roomMetrics } from "./metrics.ts";
import { FakeMetrics } from "./testutil/make-room.ts";
import { makeRoom } from "./testutil/make-room.ts";
import { encodeRaw } from "./frames.ts";
import { ZERO_ROUTE } from "./crypto.ts";
import { onMessage } from "./room/ws.ts";

describe("bounded relay traffic observability", () => {
  test("ten thousand frames need fewer than forty telemetry writes and no console logs", () => {
    const sink = new FakeMetrics();
    let draws = 0;
    let logs = 0;
    const original = console.log;
    console.log = () => { logs++; };
    try {
      for (let i = 0; i < 10_000; i++) {
        observeRelayFrame({ BUILD: "dev", METRICS: sink }, "daemon", Typ.PING, 32, "d_" + "ab".repeat(10),
          () => (++draws % RELAY_FRAME_SAMPLE_INTERVAL) / RELAY_FRAME_SAMPLE_INTERVAL);
      }
    } finally { console.log = original; }
    expect(sink.points).toHaveLength(39);
    expect(logs).toBe(0);
    expect(sink.points[0]).toMatchObject({ blobs: ["relay_frame", "daemon", "PING", "", "dev"], doubles: [256, 8192, 0] });
  });

  test("a cold object's first message can be sampled without waiting for a counter", () => {
    const sink = new FakeMetrics();
    observeRelayFrame({ METRICS: sink }, "phone", Typ.FWD, 100, "", () => 0);
    observeRelayFrame({ METRICS: sink }, "phone", Typ.FWD, 100, "", () => 1 / 256);
    expect(sink.points).toHaveLength(1);
    expect(sink.points[0].doubles).toEqual([256, 25_600, 0]);
  });

  test("traffic labels distinguish pending claims from authenticated connections", async () => {
    const h = makeRoom();
    const seen: string[] = [];
    h.core.deps.metrics = { ...roomMetrics({ BUILD: "test" }, ""), frame: role => { seen.push(role); } };
    const daemon = h.accept("daemon").ws!;
    const phone = h.accept("phone").ws!;
    const ping = encodeRaw(Typ.PING, ZERO_ROUTE, new Uint8Array(8));
    await onMessage(h.core, daemon, ping);
    await onMessage(h.core, phone, ping);
    h.core.daemon = daemon;
    await onMessage(h.core, daemon, ping);
    expect(seen).toEqual(["pending_daemon", "pending_phone", "daemon"]);
  });

  test("close codes and lifetimes remain queryable without logging peer text", () => {
    const sink = new FakeMetrics();
    observeClose({ BUILD: "test", METRICS: sink }, "other", "daemon", "", 12_000, 1006);
    expect(sink.points[0]).toMatchObject({ blobs: ["ws_close", "other", "daemon", "1006", "test"], doubles: [1, 0, 12_000] });
  });

  test("registered version metadata accepts only bounded release versions", () => {
    const sink = new FakeMetrics();
    const metrics = roomMetrics({ BUILD: "test", METRICS: sink }, "");
    metrics.registered?.("v1.4.17");
    metrics.registered?.("rt_" + "ab".repeat(16));
    metrics.registered?.("1.4.17\nprivate data");
    expect(sink.points.map(point => point.blobs?.[2])).toEqual(["1.4.17", "unknown", "unknown"]);
    expect(JSON.stringify(sink.points)).not.toContain("rt_");
  });
});
