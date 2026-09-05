import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bindLegacyGestureBoundary } from "./gesture-boundary";

function gesture(window: Window, type: "gesturestart" | "gesturechange"): Event {
  return new window.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
}

describe("legacy iOS gesture boundary", () => {
  test("ordinary page content keeps native pinch zoom", () => {
    const window = new Window({ url: "https://pairfob.com/pair" });
    const document = window.document as unknown as Document;
    const content = document.createElement("main");
    document.body.append(content);
    const dispose = bindLegacyGestureBoundary(document);

    for (const type of ["gesturestart", "gesturechange"] as const) {
      const event = gesture(window, type);
      expect(content.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
    dispose();
  });

  test("terminal and board retain their application-owned pinch gestures", () => {
    const window = new Window({ url: "https://pairfob.com/pair" });
    const document = window.document as unknown as Document;
    const dispose = bindLegacyGestureBoundary(document);

    for (const className of ["full-terminal-host", "board-canvas"]) {
      const surface = document.createElement("section");
      const child = document.createElement("span");
      surface.className = className;
      surface.append(child);
      document.body.append(surface);
      for (const type of ["gesturestart", "gesturechange"] as const) {
        const event = gesture(window, type);
        expect(child.dispatchEvent(event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);
      }
    }

    dispose();
    const afterDispose = gesture(window, "gesturestart");
    expect(document.querySelector(".full-terminal-host")!.dispatchEvent(afterDispose)).toBe(true);
    expect(afterDispose.defaultPrevented).toBe(false);
  });
});
