import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { BackBar, BackButton } from "./navigation";

/**
 * Every screen's back control is this one button, so the double-tap guard is
 * armed here for all of them: the second half of a doubled tap presses nothing
 * on the screen that came up, whether that is a title or another back control.
 */
beforeEach(resetBoardTestDOM);
afterEach(() => {
  unmountReact();
  // A key ends whatever guard a test left armed.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
});

const AT = { clientX: 28, clientY: 26 };
/** A tap as the browser delivers it: the press, then its click. */
function tap(target: Element, at = AT): boolean {
  let delivered = true;
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, ...at }));
    delivered = target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, ...at }));
  });
  return delivered;
}
const back = () => appRoot().querySelector<HTMLButtonElement>(".back")!;

test("a doubled tap on back leaves one screen, not two, and opens nothing under it", () => {
  const left: string[] = [];
  let opened = 0;
  // Files → session → list: each screen has its back control at the same spot.
  function Screens({ depth }: { depth: number }) {
    if (!depth) return <button className="host-title" onClick={() => { opened += 1; }}>list</button>;
    return <BackBar title={`screen ${depth}`} onBack={() => { left.push(`screen ${depth}`); renderReact(<Screens depth={depth - 1} />); }} />;
  }
  act(() => renderReact(<Screens depth={2} />));
  expect(tap(back())).toBeTrue();
  // The second half lands on the session's own back control.
  expect(tap(back())).toBeFalse();
  expect(left).toEqual(["screen 2"]);
  expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("screen 1");
});

test("the title that came up under the back control is not pressed by the same doubled tap", () => {
  let opened = 0;
  function Screen({ open }: { open: boolean }) {
    return open
      ? <BackButton onBack={() => renderReact(<Screen open={false} />)} label="back to the board" />
      : <button className="host-title" onClick={() => { opened += 1; }}>workspace</button>;
  }
  act(() => renderReact(<Screen open />));
  expect(back().getAttribute("aria-label")).toBe("back to the board");
  tap(back());
  const title = appRoot().querySelector<HTMLButtonElement>(".host-title")!;
  expect(tap(title)).toBeFalse();
  expect(opened).toBe(0);
  // Somewhere else on the new screen the reader's tap is their own, at once.
  // (A key ends the first guard, as the interval would; the test does not wait it out.)
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  act(() => renderReact(<Screen open />));
  tap(back());
  expect(tap(appRoot().querySelector<HTMLButtonElement>(".host-title")!, { clientX: 200, clientY: 300 })).toBeTrue();
  expect(opened).toBe(1);
});

test("the keyboard goes back as often as it is pressed", () => {
  const left: number[] = [];
  function Screens({ depth }: { depth: number }) {
    if (!depth) return <p>list</p>;
    return <BackBar title="screen" onBack={() => { left.push(depth); renderReact(<Screens depth={depth - 1} />); }} />;
  }
  act(() => renderReact(<Screens depth={2} />));
  // Enter and Space click with `detail` 0: nothing is armed and nothing is swallowed.
  act(() => back().click());
  act(() => back().click());
  expect(left).toEqual([2, 1]);
});
