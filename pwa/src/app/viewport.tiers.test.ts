import { afterEach, expect, test } from "bun:test";
import "../../test-support/dom";
import { DESK_QUERY, ROOMY_QUERY, WIDE_QUERY, handheld, isDesk, isRoomy, isWide } from "./viewport";

/**
 * The tiers as devices meet them. A width alone cannot tell a phone on its side
 * from a tablet in portrait, so each case states the viewport and the screen.
 */
const realMatchMedia = window.matchMedia;
const realScreen = Object.getOwnPropertyDescriptor(globalThis, "screen");

function device(width: number, height: number): void {
  const min = (query: string): number => Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0);
  window.matchMedia = ((query: string) => ({ matches: width >= min(query), media: query })) as typeof window.matchMedia;
  Object.defineProperty(globalThis, "screen", { value: { width, height }, configurable: true });
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
  if (realScreen) Object.defineProperty(globalThis, "screen", realScreen);
});

const tiers = () => ({ handheld: handheld(), desk: isDesk(), roomy: isRoomy(), wide: isWide() });

test("the queries are the thresholds listeners subscribe to", () => {
  expect([DESK_QUERY, ROOMY_QUERY, WIDE_QUERY]).toEqual(["(min-width: 720px)", "(min-width: 900px)", "(min-width: 1200px)"]);
});

test("a phone stays a phone on its side", () => {
  device(390, 844);
  expect(tiers()).toEqual({ handheld: true, desk: false, roomy: false, wide: false });
  // Wider than a tablet's portrait width, with a third of its height.
  device(844, 390);
  expect(tiers()).toEqual({ handheld: true, desk: false, roomy: false, wide: false });
  // The largest phones always crossed the old 900px line; the list stays beside
  // the page there, but nothing else a roomy layout offers.
  device(932, 430);
  expect(tiers()).toEqual({ handheld: true, desk: true, roomy: false, wide: false });
});

test("a tablet gets the list beside the page in portrait and more with width", () => {
  device(744, 1133);
  expect(tiers()).toEqual({ handheld: false, desk: true, roomy: false, wide: false });
  device(820, 1180);
  expect(tiers()).toEqual({ handheld: false, desk: true, roomy: false, wide: false });
  device(1180, 820);
  expect(tiers()).toEqual({ handheld: false, desk: true, roomy: true, wide: false });
  device(1366, 1024);
  expect(tiers()).toEqual({ handheld: false, desk: true, roomy: true, wide: true });
});

test("a narrow window on a large screen follows its width", () => {
  window.matchMedia = ((query: string) => ({ matches: 800 >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0), media: query })) as typeof window.matchMedia;
  Object.defineProperty(globalThis, "screen", { value: { width: 1728, height: 1117 }, configurable: true });
  expect(tiers()).toEqual({ handheld: false, desk: true, roomy: false, wide: false });
});
