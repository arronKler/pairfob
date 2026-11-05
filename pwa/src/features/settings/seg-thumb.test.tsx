import { resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { compileScss } from "../../../test-support/compiled-style";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { SegmentedControl, SegmentedOption } from "../../shared/ui/primitives";
import { SegThumb } from "./seg-thumb";

/**
 * The settings bar's thumb: it takes the chosen segment's measured box, slides
 * for a choice and only for a choice. The test DOM lays nothing out, so each
 * segment's box is given by its `data-box` ("left,width").
 */
// The whole stylesheet, as the other settings style tests read it: the shared bar's rules are part of the answer.
const css = compileScss(new URL("../../style.scss", import.meta.url)).css.replace(/\/\*[\s\S]*?\*\//g, "");
const declared = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim()).includes(selector)).map(match => match[2]).join("\n");
const box = (node: HTMLElement) => (node.dataset.box ?? "0,0").split(",").map(Number);
/** Each forced style read of the thumb, with whether its transition was off at that moment. */
let flushes: boolean[] = [];
let restore: Array<() => void> = [];

function Bar({ on, boxes }: { on: number; boxes: string[] }) {
  return <SegmentedControl className="set-seg" aria-label="mode">
    <SegThumb />
    {boxes.map((value, index) => <SegmentedOption key={index} selected={index === on} data-box={value}>{`s${index}`}</SegmentedOption>)}
  </SegmentedControl>;
}
const thumb = () => document.querySelector(".set-seg-thumb") as HTMLElement;
const placed = () => [thumb().style.getPropertyValue("--set-seg-x"), thumb().style.getPropertyValue("--set-seg-w")];

beforeEach(async () => {
  await resetBoardTestDOM();
  flushes = [];
  const proto = HTMLElement.prototype;
  for (const [name, read] of [
    ["offsetLeft", (node: HTMLElement) => box(node)[0]],
    ["offsetWidth", (node: HTMLElement) => {
      if (node.classList.contains("set-seg-thumb")) { flushes.push(node.classList.contains("is-still")); return 0; }
      return box(node)[1];
    }],
  ] as const) {
    const before = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { configurable: true, get(this: HTMLElement) { return read(this); } });
    restore.push(() => { if (before) Object.defineProperty(proto, name, before); else delete (proto as unknown as Record<string, unknown>)[name]; });
  }
});
afterEach(() => { unmountReact(); restore.splice(0).forEach(undo => undo()); });

test("the first placement is written still: the thumb is under the choice before anything can travel", () => {
  renderReact(<Bar on={1} boxes={["2,60", "64,90", "156,40"]} />);
  expect(thumb().getAttribute("aria-hidden")).toBe("true");
  // First in the bar, so the labels paint over it.
  expectSameNode(thumb().parentElement?.firstElementChild, thumb());
  expect(placed()).toEqual(["64px", "90px"]);
  expect(thumb().classList.contains("is-placed")).toBeTrue();
  expect(flushes).toEqual([true]);
  expect(thumb().classList.contains("is-still")).toBeFalse();
});

test("a choice slides the thumb; the same choice drawn again, or its box moving, does not", () => {
  renderReact(<Bar on={0} boxes={["2,60", "64,90", "156,40"]} />);
  const node = thumb();
  flushes = [];
  renderReact(<Bar on={2} boxes={["2,60", "64,90", "156,40"]} />);
  expectSameNode(thumb(), node);
  expect(placed()).toEqual(["156px", "40px"]);
  // No still write: the transition carries it.
  expect(flushes).toEqual([]);
  expect(node.classList.contains("is-still")).toBeFalse();
  // A repaint writes nothing.
  renderReact(<Bar on={2} boxes={["2,60", "64,90", "156,40"]} />);
  expect(flushes).toEqual([]);
  // Another language's words: same choice, another box, written still.
  renderReact(<Bar on={2} boxes={["2,80", "84,110", "196,70"]} />);
  expect(placed()).toEqual(["196px", "70px"]);
  expect(flushes).toEqual([true]);
  expect(node.classList.contains("is-still")).toBeFalse();
});

test("a bar that is not laid out leaves the choice to the segment, and the next choice does not slide in from nowhere", () => {
  renderReact(<Bar on={0} boxes={["0,0", "0,0"]} />);
  expect(thumb().classList.contains("is-placed")).toBeFalse();
  renderReact(<Bar on={1} boxes={["2,60", "64,90"]} />);
  expect(thumb().classList.contains("is-placed")).toBeTrue();
  expect(placed()).toEqual(["64px", "90px"]);
  expect(flushes).toEqual([true]);
});

test("the thumb travels on transform and width at the element duration, and the segment keeps its ground without it", () => {
  expect(declared(".set-seg-thumb")).toMatch(/transition:\s*transform var\(--dur-2\) var\(--ease\),\s*width var\(--dur-2\) var\(--ease\)/);
  expect(declared(".set-seg-thumb")).toMatch(/transform:\s*translateX\(var\(--set-seg-x, 0\)\)/);
  expect(declared(".set-seg-thumb.is-still")).toMatch(/transition:\s*none/);
  expect(declared(".set-seg .seg-item")).toMatch(/transition:\s*color var\(--dur-2\) var\(--ease\)/);
  // The chosen segment has no ground of its own once the thumb is under it.
  expect(declared(".set-seg .seg-item.on")).toBe("");
  expect(declared(".set-seg:not(:has(> .set-seg-thumb.is-placed)) .seg-item.on")).toMatch(/background:\s*var\(--bg\)/);
});
