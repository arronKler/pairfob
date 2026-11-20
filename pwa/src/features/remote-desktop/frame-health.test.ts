import { expect, test } from "bun:test";
import { DesktopFrameHealth } from "./frame-health";

test("a static picture stays interactive only with fresh proof of the exact presented RTP frame", () => {
  const health = new DesktopFrameHealth(0);
  health.presented(20, 0xffffffff);
  for (let ms = 1000; ms < 12000; ms += 1000) {
    health.observed({ rtp_time: 0xffffffff, healthy: true }, ms);
    expect(health.allowsInput(ms + 900)).toBe(true);
    expect(health.expired(ms)).toBe(false);
  }
  health.observed({ rtp_time: 0, healthy: true }, 12000);
  expect(health.allowsInput(12000)).toBe(false);
  expect(health.requestKeyframe(12000)).toBe(true);
  expect(health.requestKeyframe(13000)).toBe(false);
  health.playbackProgress(13500); // decode counters alone cannot confirm presentation
  expect(health.allowsInput(13500)).toBe(false);
  health.presented(14000, 0);
  health.observed({ rtp_time: 0, healthy: true }, 15000);
  expect(health.allowsInput(16000)).toBe(true);
  expect(health.allowsInput(17000)).toBe(false);
  expect(health.expired(22000)).toBe(true);
});

test("legacy receivers wait for first video and require ongoing playback", () => {
  const health = new DesktopFrameHealth(10);
  health.observed({ rtp_time: 1, healthy: true }, 100);
  expect(health.observe).toBe(false);
  expect(health.allowsInput(100)).toBe(false);
  expect(health.expired(15011)).toBe(true);
  health.playbackProgress(16000);
  expect(health.allowsInput(16500)).toBe(true);
  expect(health.expired(22600)).toBe(true);
});

test("unhealthy host and delayed heartbeat cannot authorize input on an old picture", () => {
  const health = new DesktopFrameHealth(0);
  health.presented(0, 123);
  health.observed({ rtp_time: 123, healthy: false }, 4000);
  expect(health.allowsInput(4000)).toBe(false);
  health.observed({ rtp_time: 123, healthy: true }, 4500);
  expect(health.allowsInput(6500)).toBe(false);
});
