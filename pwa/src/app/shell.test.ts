import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetBoardTestDOM } from "../../test-support/dom";
import { appRoot } from "./dom-root";
import { computeLayout, type LayoutDescriptor } from "./layout";
import { applyShell, clearShell, useAppShell } from "./shell";

function layout(overrides: Partial<Parameters<typeof computeLayout>[0]> = {}): LayoutDescriptor {
  return computeLayout({
    phase: "live", screen: "pane", fullTerminal: false, agentChat: false, desk: false,
    hasSelectedPane: true, termFontPx: 12, operationBusy: false, ...overrides,
  });
}

/** A stand-in for `<App/>`: the shell hook is the whole render. */
function ShellHost({ descriptor }: { descriptor: LayoutDescriptor | null }) {
  useAppShell(descriptor);
  useEffect(() => () => undefined, []);
  return null;
}

let root: Root | null = null;
let host: HTMLElement;

beforeEach(async () => {
  await resetBoardTestDOM();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host.remove();
  clearShell();
});

function shellState(): Record<string, unknown> {
  const app = appRoot();
  return {
    classes: app.className,
    busy: app.getAttribute("aria-busy"),
    font: app.style.getPropertyValue("--term-fs"),
    lineHeight: app.style.getPropertyValue("--term-lh"),
    htmlLock: document.documentElement.classList.contains("lock"),
    bodyLock: document.body.classList.contains("lock"),
  };
}

describe("shell ownership", () => {
  test("the session shell describes the phone pane and locks the document", () => {
    applyShell(layout());
    expect(appRoot().classList.contains("session")).toBeTrue();
    expect(appRoot().classList.contains("desk")).toBeFalse();
    expect(document.documentElement.classList.contains("lock")).toBeTrue();
    expect(document.body.classList.contains("lock")).toBeTrue();
    expect(appRoot().style.getPropertyValue("--term-fs")).toBe("12px");
    expect(appRoot().style.getPropertyValue("--term-lh")).toBe("18px");
    expect(appRoot().getAttribute("aria-busy")).toBe("false");
  });

  test("the desk and board shells are mutually exclusive with the phone session", () => {
    applyShell(layout({ desk: true, screen: "home", hasSelectedPane: false }));
    expect(appRoot().classList.contains("desk")).toBeTrue();
    expect(appRoot().classList.contains("session")).toBeFalse();

    applyShell(layout({ screen: "board" }));
    expect(appRoot().classList.contains("board")).toBeTrue();
    expect(appRoot().classList.contains("desk")).toBeFalse();

    applyShell(layout({ phase: "boot", screen: "home" }));
    expect(appRoot().classList.contains("boot-screen")).toBeTrue();
    expect(appRoot().classList.contains("board")).toBeFalse();
    expect(document.body.classList.contains("lock")).toBeTrue();

    applyShell(layout({ phase: "connect", screen: "home" }));
    expect(shellState().classes).toBe("");
    expect(document.body.classList.contains("lock")).toBeFalse();
  });

  test("applying the same shell twice changes nothing", () => {
    applyShell(layout({ termFontPx: 14, operationBusy: true }));
    const once = shellState();
    applyShell(layout({ termFontPx: 14, operationBusy: true }));
    expect(shellState()).toEqual(once);
    expect(once.busy).toBe("true");
    expect(once.font).toBe("14px");
  });

  test("unmounting the shell owner removes exactly what it added", () => {
    applyShell(layout({ termFontPx: 15 }));
    clearShell();
    expect(shellState()).toEqual({
      classes: "", busy: null, font: "", lineHeight: "", htmlLock: false, bodyLock: false,
    });
  });

  test("the mounted lifecycle applies the shell and clears it on unmount", () => {
    act(() => {
      root?.render(createElement(ShellHost, { descriptor: layout({ screen: "workspace" }) }));
    });
    expect(appRoot().classList.contains("workspace")).toBeTrue();
    expect(document.body.classList.contains("lock")).toBeTrue();

    act(() => {
      root?.render(createElement(ShellHost, { descriptor: layout({ screen: "pane" }) }));
    });
    expect(appRoot().classList.contains("workspace")).toBeFalse();
    expect(appRoot().classList.contains("session")).toBeTrue();

    act(() => {
      root?.render(createElement(ShellHost, { descriptor: null }));
    });
    // No composition yet: the last applied shell stays until unmount.
    expect(appRoot().classList.contains("session")).toBeTrue();

    act(() => { root?.unmount(); });
    root = null;
    expect(appRoot().classList.contains("session")).toBeFalse();
    expect(document.body.classList.contains("lock")).toBeFalse();
  });
});
