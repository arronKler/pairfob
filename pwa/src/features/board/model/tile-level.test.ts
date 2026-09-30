import { expect, test } from "bun:test";
import { glyphPx, tileLevel } from "./tile-level";

test("tiny tiles show the mark, readable tiles a card, and real glyphs the live screen", () => {
  // A 110×72-cell pane (880×1152 stage px) at a phone's fit scale is a card.
  expect(tileLevel(880, 1152, 0.2)).toBe("card");
  // Zoomed in until a glyph is 8px on screen, it becomes the live screen.
  expect(glyphPx(0.6)).toBeCloseTo(8, 2);
  expect(tileLevel(880, 1152, 0.61)).toBe("live");
  // Too narrow or too short for a title bar: the mark alone.
  expect(tileLevel(400, 1152, 0.2)).toBe("mark");
  expect(tileLevel(880, 200, 0.2)).toBe("mark");
});
