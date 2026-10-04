import { beforeEach, expect, test } from "bun:test";
import {
  cacheAgentTrace,
  cacheAgentTracePosture,
  cacheAgentTraceViewport,
  cachedAgentTrace,
  clearAgentTraceCache,
  forgetAgentTraceViewport,
} from "./agent-trace-cache";

beforeEach(clearAgentTraceCache);

const entry = {
  items: [{ type: "assistant" as const, text: "cached" }],
  nextCursor: null,
  note: "",
  truncated: false,
  signature: "cached",
  tail: 1,
};

test("owner-keyed viewport metadata is copied and rejected for a replacement occupant", () => {
  cacheAgentTrace("p1", { ...entry, ownerKey: "daemon:session:p1:instance-a" });
  const viewport = { anchor: "turn-a", offset: -12, scrollTop: 320, follow: false, unread: true };
  cacheAgentTraceViewport("p1", "daemon:session:p1:instance-a", viewport);
  viewport.scrollTop = 999;

  const cached = cachedAgentTrace("p1", "daemon:session:p1:instance-a");
  expect(cached?.viewport).toEqual({ anchor: "turn-a", offset: -12, scrollTop: 320, follow: false, unread: true });
  expect(cachedAgentTrace("p1", "daemon:session:p1:instance-b")).toBeNull();
});

test("legacy entries without viewport metadata remain readable", () => {
  cacheAgentTrace("p1", entry);
  expect(cachedAgentTrace("p1", "new-owner")?.items).toEqual(entry.items);
});

test("a posture update keeps the measured place and never invents one", () => {
  const owner = "daemon:session:p1:instance-a";
  cacheAgentTrace("p1", { ...entry, ownerKey: owner });
  cacheAgentTracePosture("p1", owner, { follow: false, unread: true });
  expect(cachedAgentTrace("p1", owner)?.viewport).toBeUndefined();

  cacheAgentTraceViewport("p1", owner, { anchor: "turn-a", offset: -12, scrollTop: 320, follow: true, unread: false });
  cacheAgentTracePosture("p1", "daemon:session:p1:instance-b", { follow: false, unread: true });
  expect(cachedAgentTrace("p1", owner)?.viewport?.follow).toBeTrue();
  cacheAgentTracePosture("p1", owner, { follow: false, unread: true });
  expect(cachedAgentTrace("p1", owner)?.viewport).toEqual({ anchor: "turn-a", offset: -12, scrollTop: 320, follow: false, unread: true });
});

test("forgetting the reading place keeps the transcript, also across a later re-cache", () => {
  const owner = "daemon:session:p1:instance-a";
  cacheAgentTrace("p1", { ...entry, ownerKey: owner });
  cacheAgentTraceViewport("p1", owner, { anchor: "turn-a", offset: 0, scrollTop: 320, follow: false, unread: true });
  forgetAgentTraceViewport("p1");
  cacheAgentTrace("p1", { ...entry, ownerKey: owner });
  const cached = cachedAgentTrace("p1", owner);
  expect(cached?.items).toEqual(entry.items);
  expect(cached?.viewport).toBeUndefined();
});
