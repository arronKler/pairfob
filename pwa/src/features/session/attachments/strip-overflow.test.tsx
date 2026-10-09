import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import { appRoot } from "../../../app/dom-root";
import { stripMore, useStripOverflow } from "./strip-overflow";

/**
 * A strip of thumbnails that hides its scrollbar has to say where it goes on:
 * a column that ends on a thumbnail's edge shows no sign of the next one.
 */
describe("where a strip continues", () => {
  test("nowhere when everything fits, and at whichever end has more", () => {
    expect(stripMore({ scrollLeft: 0, scrollWidth: 442, clientWidth: 442 })).toBeNull();
    // 744px, five thumbnails: the fifth starts on the strip's edge.
    expect(stripMore({ scrollLeft: 0, scrollWidth: 508, clientWidth: 442 })).toBe("end");
    expect(stripMore({ scrollLeft: 30, scrollWidth: 508, clientWidth: 442 })).toBe("both");
    expect(stripMore({ scrollLeft: 66, scrollWidth: 508, clientWidth: 442 })).toBe("start");
  });

  test("a fraction of a pixel short of an end is at it, and a mirrored strip counts from its own start", () => {
    expect(stripMore({ scrollLeft: 0.6, scrollWidth: 442.4, clientWidth: 442 })).toBeNull();
    expect(stripMore({ scrollLeft: 65.5, scrollWidth: 508, clientWidth: 442 })).toBe("start");
    expect(stripMore({ scrollLeft: -30, scrollWidth: 508, clientWidth: 442 })).toBe("both");
  });
});

describe("a strip told where it continues", () => {
  let width = { scroll: 508, client: 442 };
  const size = (strip: HTMLElement): void => {
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => width.scroll });
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => width.client });
  };

  function Strip({ shown, chips }: { shown: boolean; chips: number }) {
    const strip = useRef<HTMLDivElement>(null);
    useStripOverflow(strip);
    // As the tray does: nothing at all while it holds nothing.
    if (!shown) return null;
    return <div ref={(node) => { strip.current = node; if (node) size(node); }} className="attach-strip" data-chips={chips} />;
  }
  const strip = () => appRoot().querySelector<HTMLElement>(".attach-strip");
  const scrollTo = (left: number): void => {
    const node = strip()!;
    node.scrollLeft = left;
    Object.defineProperty(node, "scrollLeft", { configurable: true, writable: true, value: left });
    act(() => { node.dispatchEvent(new happy.Event("scroll") as unknown as Event); });
  };

  beforeEach(async () => {
    await resetBoardTestDOM();
    width = { scroll: 508, client: 442 };
  });
  afterEach(() => act(unmountReact));

  test("says so on mount, follows the scroll, and again when what it holds changes", () => {
    act(() => renderReact(<Strip shown chips={5} />));
    const node = strip()!;
    expect(node.dataset.more).toBe("end");
    scrollTo(30);
    expect(node.dataset.more).toBe("both");
    scrollTo(66);
    expect(node.dataset.more).toBe("start");
    // A file removed: the rest fit, and the strip is whole again.
    width = { scroll: 442, client: 442 };
    scrollTo(0);
    act(() => renderReact(<Strip shown chips={4} />));
    expectSameNode(strip(), node);
    expect("more" in node.dataset).toBeFalse();
  });

  test("a strip that went away and came back is watched again", () => {
    act(() => renderReact(<Strip shown chips={5} />));
    const first = strip()!;
    act(() => renderReact(<Strip shown={false} chips={0} />));
    expect(strip()).toBeNull();
    act(() => renderReact(<Strip shown chips={5} />));
    const second = strip()!;
    expectDifferentNode(second, first);
    expect(second.dataset.more).toBe("end");
    scrollTo(66);
    expect(second.dataset.more).toBe("start");
    // The one that left is no longer listened to.
    first.dataset.more = "end";
    first.dispatchEvent(new happy.Event("scroll") as unknown as Event);
    expect(first.dataset.more).toBe("end");
  });
});
