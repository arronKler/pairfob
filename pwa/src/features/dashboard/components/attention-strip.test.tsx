import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import type { HerdAttentionItem } from "../model/herd-view";
import { AttentionStrip } from "./attention-strip";

const items: HerdAttentionItem[] = ["a", "b", "c", "d"].map((paneId) => (
  { paneId, title: `Session ${paneId}`, workspace: "alpha", agentKind: "codex", kind: "blocked" }));

const strip = () => appRoot().querySelector<HTMLElement>(".attn-strip")!;

/** The test realm lays nothing out: give the strip a scrollable width. */
function sized(scrollWidth: number, clientWidth: number): HTMLElement {
  const node = strip();
  Object.defineProperty(node, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(node, "clientWidth", { value: clientWidth, configurable: true });
  return node;
}

function wheel(init: WheelEventInit): WheelEvent {
  const event = new happy.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }) as unknown as WheelEvent;
  // The test realm's wheel event drops the modifier a pinch carries.
  if (init.ctrlKey) Object.defineProperty(event, "ctrlKey", { value: true });
  act(() => { strip().dispatchEvent(event); });
  return event;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(() => { act(() => unmountReact()); });

describe("the needs-you strip under a wheel", () => {
  test("in the rail an up-down wheel walks the tickets sideways and stops at the ends", () => {
    renderReact(<AttentionStrip items={items} onOpen={() => {}} onLocate={() => {}} wheel />);
    const node = sized(900, 280);
    expect(wheel({ deltaY: 120 }).defaultPrevented).toBe(true);
    expect(node.scrollLeft).toBe(120);
    // A wheel that reports lines moves a line's worth for each.
    expect(wheel({ deltaY: 3, deltaMode: 1 }).defaultPrevented).toBe(true);
    expect(node.scrollLeft).toBe(168);
    wheel({ deltaY: 5000 });
    expect(node.scrollLeft).toBe(620);
    // Nothing further that way: the wheel is not swallowed.
    expect(wheel({ deltaY: 120 }).defaultPrevented).toBe(false);
    expect(wheel({ deltaY: -5000 }).defaultPrevented).toBe(true);
    expect(node.scrollLeft).toBe(0);
    expect(wheel({ deltaY: -120 }).defaultPrevented).toBe(false);
  });

  test("a sideways wheel, a pinch and a strip that fits are left to the browser", () => {
    renderReact(<AttentionStrip items={items} onOpen={() => {}} onLocate={() => {}} wheel />);
    const node = sized(900, 280);
    expect(wheel({ deltaX: 80, deltaY: 10 }).defaultPrevented).toBe(false);
    expect(wheel({ deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(node.scrollLeft).toBe(0);
    sized(280, 280);
    expect(wheel({ deltaY: 120 }).defaultPrevented).toBe(false);
  });

  test("on the phone page the wheel still belongs to the list", () => {
    renderReact(<AttentionStrip items={items} onOpen={() => {}} />);
    const node = sized(900, 280);
    expect(wheel({ deltaY: 120 }).defaultPrevented).toBe(false);
    expect(node.scrollLeft).toBe(0);
  });
});
