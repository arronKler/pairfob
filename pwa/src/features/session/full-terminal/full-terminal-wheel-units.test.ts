import { beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { bindHostScroll } from "./full-terminal-scroll";

beforeEach(resetBoardTestDOM);
for (const [mode, deltaY, expected] of [[1, -3, 3], [2, 1, 23], [0, -108, 3]]) {
  test("vertical wheel unit " + mode + " preserves its line count", () => {
    const host = document.createElement("div");
    const calls: unknown[] = [];
    const stop = bindHostScroll(host, (direction, lines) => calls.push([direction, lines]), () => undefined, { pageLines: () => 23 });
    try {
      host.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: mode, cancelable: true }));
      expect(calls).toEqual([[deltaY < 0 ? "up" : "down", expected]]);
    } finally { stop(); }
  });
}
