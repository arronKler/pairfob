import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "navigator"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.matchMedia = happy.matchMedia.bind(happy);

const { morphingPane, nextTransition, takeTransition, transitionFor, withTransition } = await import("./transition.ts");

afterEach(() => {
  takeTransition();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe("screen transitions", () => {
  test("depth decides the direction, and a sideways move only fades", () => {
    expect(transitionFor("home", "pane")).toBe("push");
    expect(transitionFor("board", "pane")).toBe("push");
    expect(transitionFor("pane", "workspace")).toBe("push");
    expect(transitionFor("pane", "home")).toBe("pop");
    expect(transitionFor("workspace", "pane")).toBe("pop");
    expect(transitionFor("home", "settings")).toBe("fade");
    expect(transitionFor("settings", "quota")).toBe("fade");
    expect(transitionFor("home", "board")).toBe("fade");
    expect(transitionFor("home", "home")).toBe("none");
  });

  /**
   * The app repaints on every poll and every key echo. Anything that animates
   * without a navigation asking for it would animate while someone is typing.
   */
  test("a repaint nobody navigated for does not animate", () => {
    let started = 0;
    (document as unknown as { startViewTransition: (fn: () => void) => unknown }).startViewTransition = (fn) => {
      started++;
      fn();
      return { finished: Promise.resolve() };
    };
    let painted = 0;
    withTransition(takeTransition(), () => painted++);
    expect(painted).toBe(1);
    expect(started).toBe(0);
    expect(document.documentElement.dataset.transition).toBeUndefined();
  });

  test("a declared navigation is consumed exactly once", () => {
    nextTransition("push", "pane_7");
    expect(morphingPane()).toBe("pane_7");
    expect(takeTransition()).toBe("push");
    expect(takeTransition()).toBe("none");
  });

  test("declaring none never overwrites a queued direction", () => {
    nextTransition("pop", "pane_1");
    nextTransition("none");
    expect(takeTransition()).toBe("pop");
  });

  test("a paint still happens when the engine has no view transitions", () => {
    let painted = 0;
    withTransition("push", () => painted++);
    expect(painted).toBe(1);
    expect(document.documentElement.dataset.fallbackTransition).toBe("push");
  });
});
