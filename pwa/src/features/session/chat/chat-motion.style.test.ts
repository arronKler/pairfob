import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileScss } from "../../../../test-support/compiled-style";

const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const css = compileScss(new URL("../../../style.scss", import.meta.url)).css;
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string, from = css): string {
  const at = from.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return from.slice(at, from.indexOf("}", at));
}

/** Everything the stylesheet says under `prefers-reduced-motion: reduce`, and nothing else. */
function reducedMotionRules(): string {
  const blocks: string[] = [];
  const opener = "@media (prefers-reduced-motion: reduce) {";
  for (let at = css.indexOf(opener); at >= 0; at = css.indexOf(opener, at + 1)) {
    let depth = 1;
    let end = at + opener.length;
    for (; depth > 0 && end < css.length; end += 1) depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0;
    blocks.push(css.slice(at + opener.length, end - 1));
  }
  return blocks.join("\n");
}

test("the transcript's motion is written in the duration tokens, with no time of its own", () => {
  for (const sheet of ["./agent-chat.scss", "./work-card.scss"]) expect(source(sheet), sheet).not.toMatch(/\d(ms|s)\b/);
  expect(rule(".work-step")).toContain("transition: background-color var(--dur-2) var(--ease)");
  expect(rule(".work-steps > .is-arriving")).toContain("animation: fade-in var(--dur-2) var(--ease)");
  expect(rule(".agent-md")).toContain("transition: color var(--dur-3) var(--ease)");
  // After the fold above it, which takes --dur-3.
  expect(rule(".agent-reply-actions.is-arriving")).toContain("animation: fade-in var(--dur-2) var(--ease) var(--dur-3) backwards");
  // Half a press behind its bubble; the list card's sweep, as long as an element and a panel together.
  expect(rule(".pending-card.is-following")).toContain("animation-delay: calc(var(--dur-1) / 2)");
  expect(rule(".needs-card.is-raised::after")).toContain("animation: needs-sweep calc(var(--dur-2) + var(--dur-3)) var(--ease) var(--dur-2)");
  expect(rule(".needs-outcome")).toContain("animation: fade-in var(--dur-2) var(--ease)");
});

test("a choice sinks under the press and takes its selected look over a press's length", () => {
  expect(rule(".needs-option")).toContain("transition: border-color var(--dur-1) var(--ease), background-color var(--dur-1) var(--ease), transform var(--dur-1) var(--ease)");
  expect(rule(".needs-option:active:not(:disabled)")).toContain("transform: scale(0.98)");
  expect(rule(".needs-option-number")).toContain("transition: background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease)");
});

test("the rows a step displaces travel inside a clipping window, and the card's ring is drawn inside what clips it", () => {
  expect(rule(".work-steps-window")).toContain("overflow: clip");
  expect(rule(".work-steps-pushed")).toMatch(/position: absolute;[^}]*bottom: 100%/);
  expect(css).toMatch(/\.work-head:focus-visible,\s*\.work-step:focus-visible,\s*\.work-earlier:focus-visible \{\s*outline-offset: -2px;/);
  expect(rule('.work-head[aria-expanded=true] .work-chevron')).toContain("transform: rotate(90deg)");
});

test("under reduced motion the sweep and the press scale are gone; the fades stay", () => {
  const reduced = reducedMotionRules();
  expect(rule(".needs-card.is-raised::after", reduced)).toContain("animation: none");
  expect(rule(".needs-option:active:not(:disabled)", reduced)).toContain("transform: none");
  // Rise and pop lose their travel in the shared kit; nothing here puts it back.
  expect(reduced).toMatch(/\.pop-in,\s*\.rise-in,[^{]*\{\s*animation-name: fade-in;/);
  for (const fade of [".work-steps > .is-arriving", ".needs-outcome", ".agent-reply-actions.is-arriving"]) expect(reduced, fade).not.toContain(`${fade} {`);
});
