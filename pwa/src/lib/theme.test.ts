import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyDocumentTheme, setThemePref, subscribeTheme, theme, themePref, themeRevision } from "./theme.ts";

/** A root and a light/dark media query the test owns, without a browser. */
function install(systemLight: boolean) {
  const attributes = new Map<string, string>();
  // The page declares one handle per colour scheme, as index.html does.
  const metas = [
    { content: "#0a0c10", media: "(prefers-color-scheme: dark)",
      getAttribute: (name: string) => (name === "media" ? "(prefers-color-scheme: dark)" : null) },
    { content: "#f5f6f8", media: "(prefers-color-scheme: light)",
      getAttribute: (name: string) => (name === "media" ? "(prefers-color-scheme: light)" : null) },
  ];
  const listeners = new Set<() => void>();
  let light = systemLight;
  const globals = globalThis as unknown as {
    matchMedia: unknown; document: unknown; localStorage: unknown; listeners?: unknown;
  };
  const previous = { matchMedia: globals.matchMedia, document: globals.document, localStorage: globals.localStorage };
  const store = new Map<string, string>();
  globals.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  globals.document = {
    documentElement: {
      // `dataset.theme = x` and `setAttribute("data-theme", x)` are the same write.
      dataset: new Proxy<Record<string, string>>({}, {
        set: (target, key: string, value: string) => {
          target[key] = value;
          attributes.set(`data-${key}`, value);
          return true;
        },
        deleteProperty: (target, key: string) => {
          delete target[key];
          attributes.delete(`data-${key}`);
          return true;
        },
      }),
      removeAttribute: (name: string) => { attributes.delete(name); },
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    },
    cookie: "",
    querySelectorAll: () => metas,
  };
  globals.matchMedia = () => ({
    matches: light,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  });
  return {
    store, metas, listeners,
    attributes,
    flipSystem(next: boolean) {
      light = next;
      for (const fn of [...listeners]) fn();
    },
    restore() {
      globals.matchMedia = previous.matchMedia;
      globals.document = previous.document;
      globals.localStorage = previous.localStorage;
    },
  };
}

let env: ReturnType<typeof install> | null = null;
beforeEach(() => {
  env?.restore();
  env?.store.clear();
  env = install(false);
});
afterEach(() => env?.restore());

describe("the theme a document wears", () => {
  test("auto follows the system and leaves the root unmarked", () => {
    expect(themePref()).toBe("auto");
    expect(theme()).toBe("dark");
    applyDocumentTheme();
    expect(env!.attributes.has("data-theme")).toBe(false);
    env!.flipSystem(true);
    expect(theme()).toBe("light");
  });

  test("an explicit side wins over the system and is written for the reload", () => {
    setThemePref("light");
    expect(env!.attributes.get("data-theme")).toBe("light");
    expect(env!.store.get("pairfob_theme")).toBe("light");
    // The system flipping under an explicit choice changes nothing.
    env!.flipSystem(false);
    expect(theme()).toBe("light");
    setThemePref("dark");
    expect(env!.attributes.get("data-theme")).toBe("dark");
    expect(theme()).toBe("dark");
  });

  test("going back to auto clears the stored choice and the attribute", () => {
    setThemePref("light");
    setThemePref("auto");
    expect(env!.store.has("pairfob_theme")).toBe(false);
    expect(env!.attributes.has("data-theme")).toBe(false);
  });

  test("the browser chrome colour follows the palette, and each scheme keeps its own", () => {
    // Following the system, each meta holds the value its own media query declares.
    applyDocumentTheme();
    expect(env!.metas.map((meta) => meta.content)).toEqual(["#0a0c10", "#f5f6f8"]);
    expect(env!.metas[0]!.media).toBe("(prefers-color-scheme: dark)");
    // An explicit choice outranks the system, so both metas name that side.
    setThemePref("light");
    expect(env!.metas.map((meta) => meta.content)).toEqual(["#f5f6f8", "#f5f6f8"]);
    setThemePref("dark");
    expect(env!.metas.map((meta) => meta.content)).toEqual(["#0a0c10", "#0a0c10"]);
  });

  test("returning to auto restores each scheme's own colour", () => {
    // The review's case: system light, choose Dark, then Follow the system.
    env!.flipSystem(true);
    applyDocumentTheme();
    setThemePref("dark");
    expect(env!.metas.map((meta) => meta.content)).toEqual(["#0a0c10", "#0a0c10"]);
    setThemePref("auto");
    // The light-media tag must be light again, or the chrome keeps the manual
    // dark colour while the page has gone back to paper.
    expect(theme()).toBe("light");
    expect(env!.metas[0]!.content).toBe("#0a0c10");
    expect(env!.metas[1]!.content).toBe("#f5f6f8");
    // And a later system change still resolves to the right side.
    env!.flipSystem(false);
    expect(theme()).toBe("dark");
    applyDocumentTheme();
    expect(env!.metas.map((meta) => meta.content)).toEqual(["#0a0c10", "#f5f6f8"]);
  });

  test("a change notifies subscribers once, and a system flip only while following", () => {
    let calls = 0;
    const off = subscribeTheme(() => { calls += 1; });
    const before = themeRevision();
    setThemePref("light");
    expect(calls).toBe(1);
    expect(themeRevision()).toBe(before + 1);
    // An explicit choice ignores the system.
    env!.flipSystem(false);
    expect(calls).toBe(1);
    setThemePref("auto");
    expect(calls).toBe(2);
    env!.flipSystem(true);
    expect(calls).toBe(3);
    off();
    setThemePref("dark");
    expect(calls).toBe(3);
  });
});
