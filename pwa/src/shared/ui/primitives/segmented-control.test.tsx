import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { SegmentedControl, SegmentedOption } from "./segmented-control";

beforeEach(async () => { await resetBoardTestDOM(); });
afterEach(() => unmountReact());
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
function key(button: HTMLButtonElement, key: string) {
  act(() => button.dispatchEvent(new happy.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event));
}

function Choices({ manual = false }: { manual?: boolean }) {
  const [value, setValue] = useState("a");
  return <SegmentedControl aria-label="Choices" activation={manual ? "manual" : "automatic"}>
    {["a", "b", "c"].map(id => <SegmentedOption key={id} selected={value === id} disabled={id === "b"}
      onClick={() => setValue(id)}>{id}</SegmentedOption>)}
  </SegmentedControl>;
}

test("arrows skip disabled choices, wrap and update one tab stop with the controlled selection", () => {
  renderReact(<Choices />);
  const [a, b, c] = buttons();
  expect(buttons().map(b => b.tabIndex)).toEqual([0, -1, -1]);
  a.focus(); key(a, "ArrowRight");
  expectSameNode(document.activeElement, c);
  expect(c.getAttribute("aria-checked")).toBe("true");
  expect(b.disabled).toBeTrue();
  expect(buttons().map(b => b.tabIndex)).toEqual([-1, -1, 0]);
  key(c, "ArrowRight"); expectSameNode(document.activeElement, a);
  key(a, "End"); expectSameNode(document.activeElement, c);
  key(c, "Home"); expectSameNode(document.activeElement, a);
});

test("manual groups move focus without invoking an action or changing selection", () => {
  renderReact(<Choices manual />);
  const [a, , c] = buttons();
  a.focus(); key(a, "ArrowRight");
  expectSameNode(document.activeElement, c);
  expect(a.getAttribute("aria-checked")).toBe("true");
  expect(c.getAttribute("aria-checked")).toBe("false");
  act(() => c.click());
  expect(c.getAttribute("aria-checked")).toBe("true");
});

test("a disabled selection falls back to the first enabled choice without firing changes", () => {
  let calls = 0;
  renderReact(<SegmentedControl aria-label="Unavailable">
    <SegmentedOption selected disabled>Selected but disabled</SegmentedOption>
    <SegmentedOption selected={false} onClick={() => calls++}>Available</SegmentedOption>
  </SegmentedControl>);
  expect(buttons().map(b => b.tabIndex)).toEqual([-1, 0]);
  expect(calls).toBe(0);
});

test("controlled publications preserve DOM identity and expose the new selected tab stop", () => {
  const view = (selected: boolean) => <SegmentedControl aria-label="Live">
    <SegmentedOption selected={selected}>First</SegmentedOption>
    <SegmentedOption selected={!selected}>Second</SegmentedOption>
  </SegmentedControl>;
  renderReact(view(true)); const first = buttons()[0];
  renderReact(view(false));
  expectSameNode(buttons()[0], first);
  expect(buttons().map(b => b.tabIndex)).toEqual([-1, 0]);
});

test("nested groups retain independent tab stops and do not handle each other's arrows", () => {
  renderReact(<SegmentedControl aria-label="Outer">
    <SegmentedOption selected>Outer</SegmentedOption>
    <Choices />
  </SegmentedControl>);
  const [outer, a, , c] = buttons();
  expect(outer.tabIndex).toBe(0);
  expect(a.tabIndex).toBe(0);
  a.focus(); key(a, "ArrowRight");
  expectSameNode(document.activeElement, c);
  expect(outer.tabIndex).toBe(0);
});

test("RTL horizontal navigation reverses while modified shortcuts remain untouched", () => {
  renderReact(<SegmentedControl aria-label="RTL" style={{ direction: "rtl" }}>
    <SegmentedOption selected>First</SegmentedOption>
    <SegmentedOption selected={false}>Second</SegmentedOption>
    <SegmentedOption selected={false}>Third</SegmentedOption>
  </SegmentedControl>);
  const [a, b, c] = buttons();
  a.focus();
  const shortcut = new happy.KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => a.dispatchEvent(shortcut as unknown as Event));
  expect(shortcut.defaultPrevented).toBeFalse();
  expectSameNode(document.activeElement, a);
  key(a, "ArrowLeft");
  expectSameNode(document.activeElement, b);
  key(b, "ArrowLeft");
  expectSameNode(document.activeElement, c);
});
