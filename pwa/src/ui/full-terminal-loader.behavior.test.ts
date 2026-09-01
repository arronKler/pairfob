import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const happy = new Window({ url: "https://pairfob.com/pair" });
let saveData = false;
let visibility: DocumentVisibilityState = "visible";
let probes = 0;
let released = 0;
let idleCallbacks = 0;

for (const [name, value] of [
  ["window", happy],
  ["document", happy.document],
  ["navigator", happy.navigator],
] as const) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
Object.defineProperty(happy.navigator, "connection", {
  configurable: true,
  value: { get saveData() { return saveData; } },
});
Object.defineProperty(happy.document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});
happy.HTMLCanvasElement.prototype.getContext = ((kind: string) => {
  if (kind !== "webgl2") return null;
  probes++;
  return {
    getExtension(name: string) {
      return name === "WEBGL_lose_context" ? { loseContext: () => released++ } : null;
    },
  } as unknown as WebGL2RenderingContext;
}) as typeof happy.HTMLCanvasElement.prototype.getContext;
happy.requestIdleCallback = (() => {
  idleCallbacks++;
  return 1;
}) as typeof happy.requestIdleCallback;

const { fullTerminalSupported, preloadFullTerminalXterm, terminalWebglSupported } =
  await import("./full-terminal-loader.ts?behavior-regression");

afterAll(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe("full-terminal preload policy", () => {
  test("gates background work while sharing one released probe with explicit Terminal", () => {
    visibility = "hidden";
    preloadFullTerminalXterm();
    expect({ idleCallbacks, probes }).toEqual({ idleCallbacks: 0, probes: 0 });

    visibility = "visible";
    saveData = true;
    expect(fullTerminalSupported()).toBeFalse();
    preloadFullTerminalXterm();
    expect({ idleCallbacks, probes }).toEqual({ idleCallbacks: 0, probes: 0 });

    expect(terminalWebglSupported()).toBeTrue();
    expect({ probes, released }).toEqual({ probes: 1, released: 1 });
    expect(fullTerminalSupported()).toBeFalse();

    saveData = false;
    expect(fullTerminalSupported()).toBeTrue();
    preloadFullTerminalXterm();
    preloadFullTerminalXterm();
    expect({ idleCallbacks, probes, released }).toEqual({ idleCallbacks: 1, probes: 1, released: 1 });
  });
});
