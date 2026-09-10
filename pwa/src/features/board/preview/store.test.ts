import { beforeEach, describe, expect, test } from "bun:test";
import {
  boardPreviewRevision,
  boardPreviewSnapshot,
  boardPreviewText,
  clearBoardPreviews,
  enqueuePreviewPass,
  nextPreviewGeneration,
  previewGeneration,
  prunePreviews,
  publishPreview,
  runPreviewPass,
  subscribeBoardPreviews,
  type PreviewSource,
} from "./store";

function source(reads: Array<{ paneId: string; text: string; hash: string; fail?: boolean }>, log: string[]): PreviewSource {
  const byId = new Map(reads.map((read) => [read.paneId, read]));
  return {
    paneRead: async (paneId, lines) => {
      log.push(`${paneId}:${lines}`);
      const read = byId.get(paneId);
      if (!read) return { text: "", hash: "" };
      if (read.fail) throw new Error("pane.read refused");
      return { text: read.text, hash: read.hash };
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => clearBoardPreviews());

describe("board preview cache", () => {
  test("a read publishes once and notifies subscribers with a stable snapshot", () => {
    let notified = 0;
    const unsubscribe = subscribeBoardPreviews(() => {
      notified += 1;
    });
    const revision = boardPreviewRevision();
    expect(publishPreview("w1:p1", { text: "screen", hash: "h1" })).toBe(true);
    expect(notified).toBe(1);
    expect(boardPreviewRevision()).toBe(revision + 1);
    expect(boardPreviewText("w1:p1")).toBe("screen");
    const snapshot = boardPreviewSnapshot("w1:p1");
    expect(snapshot).toEqual({ text: "screen", hash: "h1" });
    unsubscribe();
    expect(publishPreview("w1:p2", { text: "other", hash: "h2" })).toBe(true);
    expect(notified).toBe(1);
  });

  test("an identical answer is skipped, a changed one is not, and a hashless read always lands", () => {
    publishPreview("w1:p1", { text: "screen", hash: "h1" });
    const snapshot = boardPreviewSnapshot("w1:p1");
    let notified = 0;
    subscribeBoardPreviews(() => {
      notified += 1;
    });
    expect(publishPreview("w1:p1", { text: "screen", hash: "h1" })).toBe(false);
    expect(boardPreviewSnapshot("w1:p1")).toBe(snapshot);
    expect(notified).toBe(0);
    expect(publishPreview("w1:p1", { text: "screen 2", hash: "h1" })).toBe(true);
    expect(notified).toBe(1);
    expect(publishPreview("w1:p2", { text: "", hash: "" })).toBe(true);
    expect(publishPreview("w1:p2", { text: "", hash: "" })).toBe(true);
    expect(notified).toBe(3);
  });

  test("a malformed read degrades to an empty screen instead of throwing", () => {
    expect(publishPreview("w1:p1", undefined)).toBe(true);
    expect(boardPreviewSnapshot("w1:p1")).toEqual({ text: "", hash: "" });
    expect(publishPreview("w1:p1", { text: 42, hash: null })).toBe(true);
    expect(boardPreviewText("w1:p1")).toBe("");
  });

  test("clearing empties the cache, notifies, and supersedes the running generation", () => {
    publishPreview("w1:p1", { text: "screen", hash: "h1" });
    const generation = previewGeneration();
    let notified = 0;
    subscribeBoardPreviews(() => {
      notified += 1;
    });
    clearBoardPreviews();
    expect(notified).toBe(1);
    expect(boardPreviewText("w1:p1")).toBe("");
    expect(previewGeneration()).toBe(generation + 1);
  });

  test("pruning publishes only when a pane was actually dropped", () => {
    publishPreview("w1:p1", { text: "a", hash: "a" });
    publishPreview("w1:p2", { text: "b", hash: "b" });
    let notified = 0;
    subscribeBoardPreviews(() => {
      notified += 1;
    });
    expect(prunePreviews(["w1:p2"])).toBe(true);
    expect(notified).toBe(1);
    expect(boardPreviewText("w1:p1")).toBe("");
    expect(boardPreviewText("w1:p2")).toBe("b");
    // Nothing to drop: a pass must not repaint the board for it.
    expect(prunePreviews(["w1:p2"])).toBe(false);
    expect(notified).toBe(1);
  });

  test("a subscriber cannot write through the snapshot it is handed", () => {
    publishPreview("w1:p1", { text: "screen", hash: "h1" });
    const snapshot = boardPreviewSnapshot("w1:p1")!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { text: string }).text = "forged";
    }).toThrow();
    expect(boardPreviewText("w1:p1")).toBe("screen");
  });
});

describe("board preview passes", () => {
  test("a pass reads serially in the order it was given, with the lines it was told", async () => {
    const log: string[] = [];
    await runPreviewPass({
      ids: ["w1:p2", "w1:p1"],
      linesOf: (paneId) => (paneId === "w1:p2" ? 40 : 24),
      source: source([
        { paneId: "w1:p1", text: "one", hash: "h1" },
        { paneId: "w1:p2", text: "two", hash: "h2" },
      ], log),
      alive: () => true,
    });
    expect(log).toEqual(["w1:p2:40", "w1:p1:24"]);
    expect(boardPreviewText("w1:p2")).toBe("two");
    expect(boardPreviewText("w1:p1")).toBe("one");
  });

  test("a failed read is skipped and the rest of the pass still lands", async () => {
    const log: string[] = [];
    await runPreviewPass({
      ids: ["bad", "good"],
      linesOf: () => 24,
      source: source([{ paneId: "bad", text: "", hash: "", fail: true }, { paneId: "good", text: "ok", hash: "g" }], log),
      alive: () => true,
    });
    expect(log).toEqual(["bad:24", "good:24"]);
    expect(boardPreviewText("bad")).toBe("");
    expect(boardPreviewText("good")).toBe("ok");
  });

  test("a superseded pass stops before its next read and publishes nothing late", async () => {
    const log: string[] = [];
    const token = nextPreviewGeneration();
    const alive = () => token === previewGeneration();
    const pass = runPreviewPass({
      ids: ["w1:p1", "w1:p2"],
      linesOf: () => 24,
      source: source([
        { paneId: "w1:p1", text: "one", hash: "h1" },
        { paneId: "w1:p2", text: "two", hash: "h2" },
      ], log),
      alive,
    });
    // Another reader starts (or the cache is cleared) while the first read is in flight.
    nextPreviewGeneration();
    await pass;
    expect(log).toEqual(["w1:p1:24"]);
    expect(boardPreviewText("w1:p1")).toBe("");
    expect(boardPreviewText("w1:p2")).toBe("");
  });

  test("queued passes never interleave, and the later one wins the cache", async () => {
    const log: string[] = [];
    const firstToken = nextPreviewGeneration();
    const first = enqueuePreviewPass(async () => {
      await runPreviewPass({
        ids: ["w1:p1"],
        linesOf: () => 24,
        source: source([{ paneId: "w1:p1", text: "stale computer", hash: "old" }], log),
        alive: () => firstToken === previewGeneration(),
      });
    });
    const secondToken = nextPreviewGeneration();
    const second = enqueuePreviewPass(async () => {
      await runPreviewPass({
        ids: ["w1:p1"],
        linesOf: () => 24,
        source: source([{ paneId: "w1:p1", text: "new computer", hash: "new" }], log),
        alive: () => secondToken === previewGeneration(),
      });
    });
    await Promise.all([first, second]);
    await settle();
    expect(log).toEqual(["w1:p1:24"]);
    expect(boardPreviewText("w1:p1")).toBe("new computer");
  });
});
