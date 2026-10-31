import { expectSameNode } from "../../../../test-support/node-identity";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import { SendButton } from "./compose-controls";
import type { SendKind } from "./session-stop";

/**
 * The send button changing kind in place: the label fades in on a change and
 * only on a change, and the width eases from what it was, except in the
 * complete terminal.
 */

type Move = { frames: Keyframe[]; duration: number; cancelled: boolean };

let moves: Move[] = [];
let widths: Partial<Record<SendKind, number>> = {};
let restore: Array<() => void> = [];
let resized: ResizeObserverCallback | null = null;

/** The entry a browser delivers for a box that settled at `width`. */
function deliver(width: number): void {
  act(() => resized?.([{ borderBoxSize: [{ inlineSize: width, blockSize: 46 }], contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
}

/** Layout for a DOM that has none: every send button is as wide as `widths` says its kind is, and records its moves. */
function fakeLayout(): void {
  const proto = HTMLButtonElement.prototype as HTMLButtonElement & { animate?: unknown };
  const animate = Object.getOwnPropertyDescriptor(proto, "animate");
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLButtonElement) {
      const width = widths[this.dataset.sendKind as SendKind] ?? 0;
      return { width, height: 46, left: 0, top: 0, right: width, bottom: 46, x: 0, y: 0, toJSON: () => ({}) };
    },
  });
  Object.defineProperty(proto, "animate", {
    configurable: true,
    value(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const move: Move = { frames, duration: Number(options.duration), cancelled: false };
      moves.push(move);
      return { playState: "finished", cancel: () => { move.cancelled = true; } };
    },
  });
  // A DOM without layout reports no size of its own; the test says when a box settled.
  const view = document.defaultView as unknown as { ResizeObserver: typeof ResizeObserver };
  const observer = view.ResizeObserver ?? globalThis.ResizeObserver;
  resized = null;
  const fake = class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() { /* the test delivers, the browser would */ }
    unobserve() { /* one box, one observation */ }
    disconnect() { resized = null; }
  } as unknown as typeof ResizeObserver;
  view.ResizeObserver = fake;
  globalThis.ResizeObserver = fake;
  restore.push(() => {
    view.ResizeObserver = observer;
    globalThis.ResizeObserver = observer;
    delete (proto as unknown as Record<string, unknown>).getBoundingClientRect;
    if (animate) Object.defineProperty(proto, "animate", animate);
    else delete (proto as unknown as Record<string, unknown>).animate;
  });
}

function button(kind: SendKind, percent = 0): ReactNode {
  return <SendButton kind={kind} percent={percent} className="send-btn" onSend={() => undefined} stopTarget={null} longPressStops={false} />;
}

const send = () => appRoot().querySelector<HTMLButtonElement>(".send-btn")!;
const label = () => send().querySelector<HTMLElement>(".send-label")!;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  moves = [];
  widths = { enter: 46, send: 66, wait: 132, stop: 80, stopping: 104, force: 104 };
  fakeLayout();
});

afterEach(() => {
  act(() => unmountReact());
  for (const undo of restore) undo();
  restore = [];
});

describe("the label of a button that changed kind", () => {
  test("a first paint and the same kind drawn again are still", () => {
    act(() => renderReact(button("send")));
    const first = label();
    expect(first.classList.contains("swap-in")).toBeFalse();
    act(() => renderReact(button("send")));
    expectSameNode(label(), first);
    expect(label().classList.contains("swap-in")).toBeFalse();
  });

  test("a new kind fades its label in, in the wrapper the old one stood in", () => {
    act(() => renderReact(button("send")));
    const face = send().querySelector(".send-face");
    act(() => renderReact(button("stop")));
    expectSameNode(send().querySelector(".send-face"), face);
    expect(label().classList.contains("swap-in")).toBeTrue();
    expect(label().textContent).toBe("停止");
    // 停止 -> 正在停止…: the wrapper only gains the reserved width, the label fades again.
    act(() => renderReact(button("stopping")));
    expectSameNode(send().querySelector(".send-face"), face);
    expect(face?.classList.contains("send-reserve")).toBeTrue();
    expect(label().classList.contains("swap-in")).toBeTrue();
  });

  test("an upload's percent ticking in the label is not a change of kind", () => {
    act(() => renderReact(button("wait", 12)));
    const first = label();
    act(() => renderReact(button("wait", 57)));
    expectSameNode(label(), first);
    expect(label().classList.contains("swap-in")).toBeFalse();
    expect(label().textContent).toContain("57");
  });
});

describe("the width of a button that changed kind", () => {
  test("eases from the width it had to the width its new label needs", () => {
    act(() => renderReact(button("send")));
    expect(moves).toEqual([]);
    act(() => renderReact(button("stop")));
    expect(moves).toEqual([{ frames: [{ width: "66px", overflow: "hidden" }, { width: "80px", overflow: "hidden" }], duration: 180, cancelled: false }]);
  });

  test("the same kind drawn again plays nothing, whatever its label does", () => {
    act(() => renderReact(button("wait", 12)));
    widths.wait = 140;
    act(() => renderReact(button("wait", 99)));
    // The browser reports the box the label grew to; a label growing is not a move.
    deliver(140);
    expect(moves).toEqual([]);
    // The width it grew to is where the next change starts from.
    act(() => renderReact(button("send")));
    expect(moves[0].frames.map((frame) => frame.width)).toEqual(["140px", "66px"]);
  });

  test("two kinds of one width move nothing", () => {
    act(() => renderReact(button("stopping")));
    act(() => renderReact(button("force")));
    expect(moves).toEqual([]);
  });

  test("the complete terminal's button changes width at once", () => {
    act(() => renderReact(<div className="full-terminal-pad">{button("send")}</div>));
    act(() => renderReact(<div className="full-terminal-pad">{button("stop")}</div>));
    expect(send().dataset.sendKind).toBe("stop");
    expect(moves).toEqual([]);
  });
});
