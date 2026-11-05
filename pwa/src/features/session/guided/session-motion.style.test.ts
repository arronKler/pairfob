import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

/**
 * The session's motion as the compiled stylesheet says it: which properties
 * move, on which of the four durations, and that each exit is its entrance a
 * step shorter. A test DOM runs no animation, so the rules are read.
 */

const css = compileScss(new URL("../../../connected.scss", import.meta.url)).css;

/** The declarations of every rule whose selector list is exactly `selector`, joined. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const found = [...css.matchAll(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm"))].map((match) => match[1]);
  if (!found.length) throw new Error(`missing rule ${selector}`);
  return found.join("\n");
}

const keyframes = (name: string): string => {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start < 0) throw new Error(`missing keyframes ${name}`);
  return css.slice(start, css.indexOf("\n}", start));
};

describe("the send button changing kind", () => {
  test("ground, edge and ink cross over together on an element's duration; a press keeps a press's pace", () => {
    for (const button of [".send-btn", ".full-terminal-compose-send"]) {
      const transition = /transition:\s*([^;]*);/.exec(rule(button))![1];
      expect(transition, button).toContain("background-color var(--dur-2) var(--ease)");
      expect(transition, button).toContain("border-color var(--dur-2) var(--ease)");
      expect(transition, button).toContain("color var(--dur-2) var(--ease)");
      expect(transition, button).toContain("transform var(--dur-1) var(--ease)");
      // Its width is eased by measure where it may be (compose-controls.tsx), never by a rule that would also reach the complete terminal.
      expect(transition, button).not.toContain("width");
    }
    expect(rule(".send-btn:active:not(:disabled)")).toMatch(/transition-duration:\s*var\(--dur-1\)/);
    expect(rule(".full-terminal-compose-send:active")).toMatch(/transition-duration:\s*var\(--dur-1\)/);
  });
});

describe("the dock's two-way switch", () => {
  test(".pad-kind slides one thumb to the pressed side", () => {
    const track = ".pad-kind";
    const option = ".pad-kind-option";
    expect(rule(track)).toMatch(/grid-auto-columns:\s*1fr/);
    const thumb = rule(`${track}::before`);
    expect(thumb).toMatch(/width:\s*calc\(\(100% - 2 \* 2px\) \/ 2\)/);
    expect(thumb).toMatch(/transition:\s*transform var\(--dur-2\) var\(--ease\)/);
    expect(rule(`${track}:has(> ${option}:last-child[aria-pressed=true])::before`)).toMatch(/transform:\s*translateX\(100%\)/);
    // The option draws no ground of its own any more; its label eases with the thumb.
    expect(rule(option)).toMatch(/background:\s*transparent/);
    expect(rule(option)).toMatch(/transition:\s*color var\(--dur-2\) var\(--ease\)/);
    expect(rule(`${option}[aria-pressed=true]`)).not.toMatch(/background/);
    // Drawn anew by the press that turned it, it slides in from the side it was told.
    expect(rule(`${track}[data-from=first]::before`)).toMatch(/animation:\s*dock-switch-from-first var\(--dur-2\) var\(--ease\)/);
    expect(rule(`${track}[data-from=last]::before`)).toMatch(/animation:\s*dock-switch-from-last var\(--dur-2\) var\(--ease\)/);
  });
});

describe("small floating things leave the way they came, a step shorter", () => {
  test("the row bubble", () => {
    expect(rule(".row-bubble")).toMatch(/animation:\s*row-bubble-in var\(--dur-2\) var\(--ease\)/);
    expect(rule(".row-bubble.is-leaving")).toMatch(/animation:\s*row-bubble-out var\(--dur-1\) var\(--ease\) forwards/);
    // One animation for both sides: changing side as its row nears the top must not play the entrance again.
    expect(rule(".row-bubble[data-side=below]")).toMatch(/--row-bubble-from:\s*-4px/);
    expect(rule(".row-bubble[data-side=below]")).not.toMatch(/animation/);
    expect(keyframes("row-bubble-in")).toContain("translateY(var(--row-bubble-from, 4px)) scale(0.97)");
    expect(keyframes("row-bubble-out")).toContain("translateY(var(--row-bubble-from, 4px)) scale(0.97)");
  });

  test("the selection hint, with the buffer's ring", () => {
    expect(rule(".select-hint.is-leaving")).toMatch(/animation:\s*row-bubble-out var\(--dur-1\) var\(--ease\) forwards/);
    expect(rule(".select-hint")).toMatch(/--row-bubble-from:\s*-4px/);
    expect(rule(".select-hint.is-below")).toMatch(/--row-bubble-from:\s*4px/);
    // After the rules that name its entrance by place, or they would win.
    expect(css.indexOf(".select-hint.is-leaving {")).toBeGreaterThan(css.indexOf(".select-hint.is-beside-rail {"));
    expect(rule(".term")).toMatch(/transition:\s*box-shadow var\(--dur-1\) var\(--ease\)/);
    expect(rule(".term.selecting")).toMatch(/transition-duration:\s*var\(--dur-2\)/);
  });

  test("the picked row's tint", () => {
    expect(rule(".term-line")).toMatch(/transition:\s*box-shadow var\(--dur-1\) var\(--ease\)/);
  });

  test("the attachment action bar and the floating notice", () => {
    expect(rule(".attach-pop")).toMatch(/animation:\s*attach-pop-in var\(--dur-2\) var\(--ease\)/);
    expect(rule(".attach-pop.is-leaving")).toMatch(/animation:\s*attach-pop-out var\(--dur-1\) var\(--ease\) forwards/);
    expect(keyframes("attach-pop-out")).toMatch(/to \{\s*opacity: 0;\s*transform: scale\(0\.96\);/);
    expect(rule(".session-notice.is-leaving > .notice")).toMatch(/animation:\s*session-notice-out var\(--dur-1\) var\(--ease\) forwards/);
  });

  test("the jump chip: the class a chat or a buffer puts on it while it leaves", () => {
    const out = rule(".term-jump.term-jump-out,\n.agent-jump.term-jump-out");
    expect(out).toMatch(/animation:\s*term-jump-out var\(--dur-1\) var\(--ease\) forwards/);
    expect(out).toMatch(/pointer-events:\s*none/);
  });
});

describe("the attachment tray", () => {
  test("is clipped only while it folds, and never eases where its height is terminal rows", () => {
    expect(rule(".attach-fold.is-rest > .fold-body")).toMatch(/overflow:\s*visible/);
    expect(rule(".attach-fold.is-instant")).toMatch(/transition:\s*none/);
  });

  test("a thumbnail joins and leaves by its width, closing the gap it adds", () => {
    expect(rule(".attach-chip-wrap.is-entering")).toMatch(/animation:\s*attach-chip-in var\(--dur-2\) var\(--ease\) backwards/);
    expect(rule(".attach-chip-wrap.is-leaving")).toMatch(/animation:\s*attach-chip-out var\(--dur-2\) var\(--ease\) forwards/);
    for (const name of ["attach-chip-in", "attach-chip-out"]) {
      expect(keyframes(name), name).toContain("width: 0;");
      expect(keyframes(name), name).toContain("width: var(--attach-chip);");
      expect(keyframes(name), name).toContain("margin-inline-end: calc(-1 * var(--space-2));");
      expect(keyframes(name), name).toContain("transform: scale(0.96);");
    }
  });

  test("the cover of a file being sent fades off", () => {
    expect(rule(".attach-chip-cover")).toMatch(/transition:\s*opacity var\(--dur-2\) var\(--ease\)/);
    expect(rule(".attach-chip-cover.is-leaving")).toMatch(/opacity:\s*0/);
  });
});

describe("the attachment viewer", () => {
  test("its ground fades in over a panel's duration and its bars a beat later", () => {
    expect(rule("dialog.attach-viewer,\ndialog.attach-viewer::backdrop")).toMatch(/animation:\s*fade-in var\(--dur-3\) var\(--ease\)/);
    expect(rule(".attach-viewer-bar,\n.attach-viewer-foot")).toMatch(/animation:\s*fade-in var\(--dur-2\) var\(--ease\) var\(--dur-2\) backwards/);
  });

  test("closing plays it back a step shorter, and only as a short fade when motion is reduced", () => {
    expect(rule("dialog.attach-viewer[data-phase=closing],\ndialog.attach-viewer[data-phase=closing]::backdrop"))
      .toMatch(/animation:\s*attach-viewer-out var\(--dur-2\) var\(--ease\) forwards/);
    expect(rule("dialog.attach-viewer[data-phase=closing] :is(.attach-viewer-bar, .attach-viewer-foot, .attach-viewer-nav)"))
      .toMatch(/animation:\s*attach-viewer-out var\(--dur-1\) var\(--ease\) forwards/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*dialog\.attach-viewer\[data-phase=closing\],\s*dialog\.attach-viewer\[data-phase=closing\]::backdrop \{\s*animation-duration: var\(--dur-1\);/);
  });
});

describe("the session header", () => {
  test("the avatar's dot crosses to its new colour", () => {
    expect(rule(".chrome-avatar .agent-avatar-status")).toMatch(/transition:\s*background-color var\(--dur-2\) var\(--ease\)/);
  });
});

describe("no literal milliseconds", () => {
  test("every duration these rules name is one of the four tokens", () => {
    const mine = /row-bubble|select-hint|attach-pop|attach-chip|attach-fold|attach-viewer|session-notice|pad-kind|dock-mode|live-stop|send-btn|compose-send|chrome-avatar|term-jump|\.term-line|\.term\b/;
    let checked = 0;
    for (const [, selector, declarations] of css.matchAll(/(?:^|\})\s*([^{}@]+)\{([^{}]*)\}/gm)) {
      if (!mine.test(selector)) continue;
      for (const [, value] of declarations.matchAll(/(?:animation|transition)(?:-duration|-delay)?:\s*([^;]*);/g)) {
        checked += 1;
        expect(value, `${selector.trim()}: ${value}`).not.toMatch(/\d(?:ms|s)\b/);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
