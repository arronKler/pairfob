import { expect, test } from "bun:test";
import { DesktopMetrics } from "./desktop-metrics";

const videoElement = { videoWidth: 1280, videoHeight: 720 };
const base = {
  id: "video", type: "inbound-rtp", kind: "video", ssrc: 15, transportId: "transport", timestamp: 1000,
  framesDecoded: 20, totalDecodeTime: 0.2, jitterBufferDelay: 0.8, jitterBufferEmittedCount: 10, bytesReceived: 1000,
};
function report(video: Partial<RTCInboundRtpStreamStats> = {}): RTCStatsReport {
  const inbound = { ...base, ...video };
  return new Map<string, object>([
    ["transport", { type: "transport", selectedCandidatePairId: "selected" }],
    ["other", { type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.4 }],
    ["selected", { type: "candidate-pair", localCandidateId: "local", currentRoundTripTime: 0.015 }],
    ["local", { type: "local-candidate", protocol: "udp" }],
    [inbound.id, inbound],
  ]);
}

test("desktop timings use interval deltas, the matching counts, and the selected path", () => {
  const metrics = new DesktopMetrics();
  expect(metrics.sample(report(), videoElement)?.decodeMS).toBeUndefined();
  const result = metrics.sample(report({
    timestamp: 2000, framesDecoded: 30, totalDecodeTime: 0.22, jitterBufferDelay: 0.85,
    jitterBufferEmittedCount: 12, bytesReceived: 126000,
  }), videoElement, 3)!;
  expect(result.decodeMS).toBeCloseTo(2);
  expect(result.jitterBufferMS).toBeCloseTo(25);
  expect(result.receivedMbps).toBe(1);
  expect(result.rttMS).toBe(15);
  expect(result.protocol).toBe("udp");
  expect(result.encodeMS).toBe(3);
  expect(result.width).toBe(1280);
});

test("idle, absent, replaced, paused and reset counters do not report a duration", () => {
  for (const next of [
    { timestamp: 2000 },
    { timestamp: 2000, framesDecoded: undefined, jitterBufferEmittedCount: undefined },
    { timestamp: 2000, framesDecoded: 5, totalDecodeTime: 0.04, jitterBufferEmittedCount: 1, jitterBufferDelay: 0.04 },
    { timestamp: 2000, framesDecoded: 25, totalDecodeTime: 0.01, jitterBufferEmittedCount: 30, jitterBufferDelay: 0.05 },
    { timestamp: 2000, id: "replacement", framesDecoded: 25, jitterBufferEmittedCount: 30 },
    { timestamp: 2000, ssrc: 72, framesDecoded: 25, jitterBufferEmittedCount: 30 },
    { timestamp: 5000, framesDecoded: 25, jitterBufferEmittedCount: 30 },
    { timestamp: 1000, framesDecoded: 25, jitterBufferEmittedCount: 30 },
  ]) {
    const metrics = new DesktopMetrics();
    metrics.sample(report(), videoElement);
    const sample = metrics.sample(report(next), videoElement, NaN)!;
    expect(sample.decodeMS).toBeUndefined();
    expect(sample.jitterBufferMS).toBeUndefined();
    expect(sample.encodeMS).toBeUndefined();
  }
});

test("a missing inbound stream clears the previous sampling baseline", () => {
  const metrics = new DesktopMetrics();
  metrics.sample(report(), videoElement);
  expect(metrics.sample(new Map(), videoElement)).toBeNull();
  const sample = metrics.sample(report({ timestamp: 2000, framesDecoded: 25 }), videoElement)!;
  expect(sample.decodeMS).toBeUndefined();
  expect(sample.receivedMbps).toBeUndefined();
});

test("recent compositor submission to expected display uses only the frame clock", () => {
  const metrics = new DesktopMetrics();
  metrics.frame(106, { presentationTime: 102, expectedDisplayTime: 117 });
  const sample = (now: number) => metrics.sample(report(), videoElement, undefined, now)?.compositorMS;
  expect(sample(550)).toBe(15);
  expect(sample(1700)).toBeUndefined();
  metrics.frame(2000, { presentationTime: 1980, expectedDisplayTime: 1970 });
  expect(sample(2100)).toBeUndefined();
  metrics.frame(2200, { presentationTime: 2200, expectedDisplayTime: 2200 });
  expect(sample(2210)).toBe(0);
});
