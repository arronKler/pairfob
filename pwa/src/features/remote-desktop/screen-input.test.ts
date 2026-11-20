import { expect, test } from "bun:test";
import type { DesktopEvent } from "../../lib/protocol/remote-desktop";
import { attachScreenInput, screenPoint } from "./screen-input";
import { pictureBox } from "./trackpad-aim";

function touchSurface() {
  const video = Object.assign(new EventTarget(), {
    videoWidth: 100, videoHeight: 100, clientWidth: 100, clientHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: () => {},
  });
  const events: DesktopEvent[] = [];
  const input = attachScreenInput(video as unknown as HTMLVideoElement, e => { events.push(e); return true; }, false);
  const touch = (type: string, id: number, x: number) => video.dispatchEvent(Object.assign(new Event(type), {
    pointerId: id, pointerType: "touch", clientX: x, clientY: 50,
  }));
  return { events, touch, input };
}

test("direct touch distinguishes a tap, drag, scroll and cancelled contact", () => {
  const { events, touch, input } = touchSurface();
  try {
    touch("pointerdown", 1, 30);
    expect(events).toEqual([]);
    touch("pointerup", 1, 30);
    expect(events.splice(0).map(e => e.kind)).toEqual(["down", "up"]);
    touch("pointerdown", 1, 30);
    touch("pointermove", 1, 50);
    touch("pointerup", 1, 50);
    expect(events.splice(0).map(e => e.kind)).toEqual(["down", "move", "up"]);
    touch("pointerdown", 1, 30);
    touch("pointerdown", 2, 70);
    touch("pointermove", 1, 20);
    touch("pointermove", 2, 60);
    touch("pointerup", 1, 20);
    touch("pointerup", 2, 60);
    expect(events.splice(0).map(e => e.kind)).toEqual(["scroll", "scroll"]);
    touch("pointerdown", 1, 40);
    touch("pointercancel", 1, 40);
    expect(events).toEqual([]);
  } finally { input.detach(); }
});

test("trackpad feedback follows only accepted touch coordinates across letterboxes and hides on cancellation or a mouse", () => {
  const rect = { width: 400, height: 400, left: -100, top: 70 } as DOMRect;
  const video = Object.assign(new EventTarget(), { videoWidth: 1600, videoHeight: 900,
    getBoundingClientRect: () => rect, setPointerCapture() {}, focus() {} });
  let accept = false;
  const shown: Array<{ x: number; y: number } | null> = [];
  const input = attachScreenInput(video as unknown as HTMLVideoElement, () => accept, true,
    { show: p => shown.push(p), hide: () => shown.push(null) });
  function pointer(type: string, x: number, y: number, pointerType = "touch") {
    video.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, pointerType, clientX: x, clientY: y }));
  }
  try {
    pointer("pointerdown", 90, 240);
    pointer("pointermove", 100, 245);
    expect(shown).toEqual([]);
    expect(input.position()).toEqual({ x: .5, y: .5 });
    accept = true;
    pointer("pointermove", 140, 290);
    expect(shown).toEqual([{ x: .6, y: .7 }]);
    pointer("pointercancel", 140, 290);
    expect(shown.at(-1)).toBeNull();
    pointer("pointerdown", 140, 290);
    pointer("pointerup", 140, 290);
    expect(shown.at(-1)).toEqual({ x: .6, y: .7 });
    pointer("pointermove", 140, 290, "mouse");
    expect(shown.at(-1)).toBeNull();
    for (const [width, height] of [[1600, 900], [900, 1600]]) {
      const box = pictureBox(rect.width, rect.height, width, height)!;
      const host = screenPoint(rect, width, height, rect.left + box.x + .3 * box.width, rect.top + box.y + .8 * box.height);
      expect(host?.x).toBeCloseTo(.3);
      expect(host?.y).toBeCloseTo(.8);
    }
  } finally { input.detach(); }
});
