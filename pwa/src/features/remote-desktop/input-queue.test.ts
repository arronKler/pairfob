import { expect, test } from "bun:test";
import type { DesktopEvent } from "../../lib/protocol/remote-desktop";
import { DesktopInputQueue } from "./input-queue";

test("congested scroll coalesces behind four outstanding writes and preserves button edges", async () => {
  const previous = globalThis.requestAnimationFrame;
  let frame: FrameRequestCallback | undefined;
  globalThis.requestAnimationFrame = callback => { frame = callback; return 1; };
  try {
    const sent: DesktopEvent[] = [];
    const acks: Array<() => void> = [];
    let failed = false;
    const queue = new DesktopInputQueue(e => {
      sent.push(e);
      return new Promise<void>(resolve => acks.push(resolve));
    }, () => { failed = true; });
    const point = { x: 0.5, y: 0.5 };
    queue.send({ kind: "down", button: "left", ...point });
    for (let i = 0; i < 120; i++) {
      queue.send({ kind: "scroll", dx: 0, dy: 1, ...point });
      const tick = frame; frame = undefined; tick?.(i);
    }
    queue.send({ kind: "up", button: "left", ...point });
    expect(sent).toHaveLength(4);
    while (acks.length) { acks.shift()!(); await Promise.resolve(); await Promise.resolve(); }
    expect(failed).toBe(false);
    expect(sent[0].kind).toBe("down");
    expect(sent.at(-1)?.kind).toBe("up");
    expect(sent.reduce((sum, e) => sum + (e.kind === "scroll" ? e.dy : 0), 0)).toBe(120);
    queue.close();
  } finally { globalThis.requestAnimationFrame = previous; }
});

test("stale-picture release discards queued input before the next acknowledgement", async () => {
  const sent: DesktopEvent[] = [];
  const acks: (() => void)[] = [];
  const queue = new DesktopInputQueue(event => {
    sent.push(event);
    return new Promise<void>(resolve => acks.push(resolve));
  }, () => { throw Error("unexpected disconnect"); });
  for (let i = 0; i < 7; i++) queue.send({ kind: "text", text: String(i) });
  queue.release();
  while (acks.length) { acks.shift()!(); await Promise.resolve(); await Promise.resolve(); }
  expect(sent.map(e => e.kind === "text" ? e.text : e.kind)).toEqual(["0","1","2","3","release"]);
});
