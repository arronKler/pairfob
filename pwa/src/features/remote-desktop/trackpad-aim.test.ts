import { expect, test } from "bun:test";
import { trackpadAim } from "./trackpad-aim";

test("ring stays at the accepted point through a video resize and expires when idle", async () => {
  // ResizeObserver is native in browser QA. This test drives the two size notifications independently.
  const previous = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let resize = () => {}, watching = false;
  class Observer {
    constructor(callback: () => void) { resize = callback; }
    observe() { watching = true; }
    disconnect() { watching = false; }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
  const rect = { width: 400, height: 400 };
  const video = Object.assign(new EventTarget(), { videoWidth: 1600, videoHeight: 900, getBoundingClientRect: () => rect });
  const ring = { hidden: true, style: { transform: "" } };
  const aim = trackpadAim(video as unknown as HTMLVideoElement, ring as unknown as HTMLElement);
  try {
    aim.show({ x: 0, y: 1 });
    expect(ring.hidden).toBeFalse();
    expect(ring.style.transform).toBe("translate(0px, 312.5px) translate(-50%, -50%)");
    rect.width = 1000; rect.height = 900;
    resize();
    expect(ring.style.transform).toContain("translate(0px, 731.25px)");
    video.videoWidth = 900; video.videoHeight = 1600;
    video.dispatchEvent(new Event("resize"));
    expect(ring.style.transform).toContain("translate(246.875px, 900px)");
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(ring.hidden).toBeTrue();
    aim.show({ x: 1, y: 0 });
  } finally {
    aim.dispose();
    if (previous) Object.defineProperty(globalThis, "ResizeObserver", previous);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
  expect(watching).toBeFalse();
  expect(ring.hidden).toBeTrue();
});
