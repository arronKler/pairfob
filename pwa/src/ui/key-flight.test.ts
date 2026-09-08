import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./key-flight.ts", import.meta.url)).text();
const keys = await Bun.file(new URL("./session/keys.ts", import.meta.url)).text();
const fullTerminal = await Bun.file(new URL("./full-terminal.ts", import.meta.url)).text();
const motion = await Bun.file(new URL("../styles/motion.scss", import.meta.url)).text();

describe("a pressed key shows where it went", () => {
  test("the spark only promises keys that are already on their way", () => {
    // The call sits after the live-session and withModifiers guards, so a key
    // that will not be sent produces no spark.
    const call = keys.indexOf("flyKeyToCursor(source, keyFlightTarget()");
    expect(call).toBeGreaterThan(keys.indexOf("if (!mapped.length) return;"));
    expect(fullTerminal.indexOf("flyKeyToCursor(source,")).toBeGreaterThan(
      fullTerminal.indexOf("if (!bytes) return;"),
    );
  });

  test("auto-repeat is throttled instead of emitting one spark per repeat", () => {
    expect(source).toContain("THROTTLE_MS");
    expect(source).toContain("now - lastFlight < THROTTLE_MS");
  });

  test("keys the terminal will not echo are marked and named", () => {
    expect(source).toContain("is-silent");
    expect(source).toContain("showLabel(layer, key)");
    expect(source).toContain('key.startsWith("ctrl+")');
    expect(motion).toContain(".key-spark.is-silent");
    expect(motion).toContain("var(--warn)");
  });

  test("reduced motion drops the travel but keeps the caret pulse and label", () => {
    const guard = source.indexOf("prefersReducedMotion()");
    expect(guard).toBeGreaterThan(source.indexOf("pulseCaret(layer, base, target)"));
    expect(guard).toBeGreaterThan(source.indexOf("showLabel(layer, key)"));
    expect(motion).toMatch(/prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.key-spark \{ display: none; \}/);
  });

  test("the layer sits outside the terminal scroller", () => {
    expect(source).toContain('term.closest(".term-wrap")');
  });

  test("the complete terminal reads the caret from the xterm buffer", () => {
    expect(fullTerminal).toContain("terminal.buffer.active");
    expect(fullTerminal).toContain("buffer.cursorX");
    expect(fullTerminal).toContain("buffer.cursorY");
  });
});
