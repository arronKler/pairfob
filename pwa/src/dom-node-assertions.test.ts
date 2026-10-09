import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../test-support/boot-dom";
import { describeNode, expectDifferentNode, expectSameNode, expectSameNodes } from "../test-support/node-identity";

/**
 * Assertions about DOM nodes have to fail when they are wrong, at once, and
 * say which node they met.
 *
 * Left to itself this Bun (1.3.14) prints a happy-dom node as everything it
 * reaches: a failed `toBeNull()` on a rendered element takes ten seconds and
 * more and a gigabyte of output, and `toBe` between two different elements
 * builds a message too long to exist, does not throw, and passes.
 * `test-support/node-inspect.ts` (preloaded from `bunfig.toml`) gives a node a
 * one-line description; `test-support/node-identity.ts` asks the identity
 * question without a matcher. These hold both in place.
 */

/** A React-rendered pair: fibres hang on these, which is what made the printed node so large. */
function rendered(): { a: HTMLElement; b: HTMLElement; done: () => void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement("div", null,
    createElement("button", { id: "save", className: "btn primary", "aria-label": "Save", onClick() {} }, "Save"),
    createElement("textarea", { className: "dock-input", onInput() {} }),
  )));
  return {
    a: host.querySelector("button")!,
    b: host.querySelector("textarea")!,
    done() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** What `run` threw, and how long it took to throw it. */
function failure(run: () => void): { message: string; ms: number } {
  const started = performance.now();
  try {
    run();
  } catch (error) {
    return { message: String((error as Error).message), ms: performance.now() - started };
  }
  throw new Error(`did not throw (${Math.round(performance.now() - started)}ms)`);
}

beforeEach(async () => {
  await resetTestDOM();
});

describe("a failed matcher on a DOM node", () => {
  test("toBe between two different elements throws at once and names both", () => {
    const { a, b, done } = rendered();
    const { message, ms } = failure(() => expect(a).toBe(b));
    done();
    expect(message).toContain('<textarea.dock-input>');
    expect(message).toContain('<button#save.btn.primary[aria-label="Save"]>');
    expect(message.length).toBeLessThan(400);
    expect(ms).toBeLessThan(250);
  });

  test("a null check on an element that is still there prints one line", () => {
    const { a, done } = rendered();
    const absent = failure(() => expect(a).toBeNull());
    const same = failure(() => expect(a).not.toBe(a));
    const listed = failure(() => expect([a]).not.toContain(a));
    done();
    for (const { message, ms } of [absent, same, listed]) {
      expect(message).toContain("<button#save.btn.primary");
      expect(message.length).toBeLessThan(400);
      expect(ms).toBeLessThan(250);
    }
  });
});

describe("node identity helpers", () => {
  test("the same node passes; a different one fails with both described", () => {
    const { a, b, done } = rendered();
    expectSameNode(a, a);
    expectSameNode(null, null);
    expectDifferentNode(a, b);
    expectDifferentNode(a, null);
    const different = failure(() => expectSameNode(a, b));
    const missing = failure(() => expectSameNode(null, b));
    const same = failure(() => expectDifferentNode(b, b));
    done();
    expect(different.message).toBe(
      'expected the same node\n  expected: textarea.dock-input\n  received: button#save.btn.primary[aria-label="Save"]',
    );
    expect(missing.message).toBe("expected the same node\n  expected: textarea.dock-input\n  received: null");
    expect(same.message).toBe("expected a different node\n  received the same: textarea.dock-input");
  });

  test("a list is the same nodes in the same order", () => {
    const { a, b, done } = rendered();
    expectSameNodes([a, b], [a, b]);
    expectSameNodes(new Set([a]), [a]);
    expectSameNodes(a.parentElement!.children, [a, b]);
    const swapped = failure(() => expectSameNodes([b, a], [a, b]));
    const short = failure(() => expectSameNodes([], [a]));
    done();
    expect(swapped.message).toContain("expected:\n    button#save");
    expect(swapped.message).toContain("received:\n    textarea.dock-input");
    expect(short.message).toContain("received: (none)");
  });

  test("a passing check still counts as an assertion", () => {
    const { a, done } = rendered();
    expect.assertions(3);
    expectSameNode(a, a);
    expectDifferentNode(a, null);
    expectSameNodes([a], [a]);
    done();
  });

  test("a node is described by what tells it apart", () => {
    const row = document.createElement("li");
    row.className = "card is-done";
    row.setAttribute("data-pane-id", "w1:p1");
    expect(describeNode(row)).toBe('li.card.is-done[data-pane-id="w1:p1"] (detached)');
    document.body.append(row);
    expect(describeNode(row)).toBe('li.card.is-done[data-pane-id="w1:p1"]');
    row.remove();
    expect(describeNode(document.createTextNode("x".repeat(40)))).toBe(`#text "${"x".repeat(32)}…" (detached)`);
    expect(describeNode(document)).toBe("#document");
    expect(describeNode(undefined)).toBe("undefined");
    expect(describeNode({})).toBe("[object Object] (not a node)");
  });
});

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("tests ask for node identity through the helpers", () => {
  const pwa = join(import.meta.dir, "..");
  // The spellings the sweep found everywhere: where focus is, and whether an element survived a render.
  const matcher = String.raw`\.(?:not\.)?(?:toBe|toEqual|toStrictEqual)\((?!null\b|undefined\b|true\b|false\b)`;
  const patterns = [
    new RegExp(String.raw`expect\([^;\n]*\bactiveElement\)${matcher}`),
    new RegExp(String.raw`expect\([^;\n]*\bquerySelector(?:All)?(?:<[^>]*>)?\([^()\n]*\)(?:\[\d+\])?!?\)${matcher}`),
    /expect\([^;\n]*\bactiveElement [!=]== (?!null\b)[^;\n]*\)\.toBe(?:True|False)?\(/,
  ];

  test("no matcher is handed a node to compare by identity", () => {
    const found: string[] = [];
    for (const file of [...testFiles(join(pwa, "src")), ...testFiles(join(pwa, "test-support"))]) {
      if (file === import.meta.path) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (patterns.some((pattern) => pattern.test(line))) found.push(`${relative(pwa, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    // Use expectSameNode / expectDifferentNode / expectSameNodes from test-support/node-identity.
    expect(found).toEqual([]);
  });
});
