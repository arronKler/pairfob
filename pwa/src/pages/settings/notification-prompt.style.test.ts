import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../test-support/compiled-style";

/**
 * The invitation floats in the corner the session dock's own surfaces open
 * into: the key panel and an attachment chip's action bar above the compose
 * row, and a blocked-attachment note over the send button. Without this rule a
 * card at z-index 70 covers most of the key panel the reader just asked for,
 * which reads as the 按键 button doing nothing.
 */
const css = compileScss(new URL("./notification-prompt.scss", import.meta.url)).css;

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`${escaped} \\{([^}]*)\\}`).exec(css);
  return found?.[1] ?? "";
}

describe("the notification invitation", () => {
  test("steps aside while a dock surface owns the corner", () => {
    const yieldTo = rule("#app:has(.pad-panel, .attach-pop, .send-issue) .notification-prompt");
    expect(yieldTo).toMatch(/visibility:\s*hidden/);
    expect(yieldTo).toMatch(/opacity:\s*0/);
    expect(yieldTo).toMatch(/pointer-events:\s*none/);
  });

  test("waits above the phone list's create button instead of covering it", () => {
    const cleared = rule("#app:has(.create-fab) .notification-prompt");
    expect(cleared).toMatch(/bottom:\s*calc\(/);
    expect(cleared).toMatch(/var\(--tab-bar-h\)/);
    expect(cleared).toMatch(/var\(--create-fab-h\)/);
  });
});
