import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../../lib/i18n";
import { SettingsContent } from "./settings-page";

/**
 * Content-only component contract on a private owned root.
 *
 * SettingsContent renders the settings body; the page wrapper and top bar
 * belong to the screen/shell that mounts it (SettingsScreen / DeskShell), so
 * the bare content with no back bar adds no .page wrapper of its own. This
 * fixture deliberately owns its own React root and typed setup — no global app
 * root — and unmounts after the assertions.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  await resetTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  setLang("zh");
});
afterEach(async () => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

test("content with no back bar renders no extra page wrapper", () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(SettingsContent, { withBack: false })));
  expect(host.querySelector(".page")).toBeNull();
  expect(host.querySelector(".topbar")).toBeNull();
  expect(host.querySelector(".settings-title")?.textContent).toBe("设置");
  expect(host.querySelector(".computer-panel .cp-main")).toBeTruthy();
  expect(host.querySelector(".set-group-label")).toBeTruthy();
});

test("the link starts at this device, named for any device and marked for the one it is", () => {
  const linkStart = (userAgent: string) => {
    Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(SettingsContent, { withBack: false })));
    const node = host.querySelector(".cp-link .cp-node:not(.is-end)")!;
    const result = { label: node.textContent, mark: node.querySelector("svg")?.getAttribute("class") ?? "" };
    act(() => root!.unmount());
    root = null;
    host.remove();
    return result;
  };
  try {
    const phone = linkStart("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1");
    expect(phone.label).toBe("这台设备");
    expect(phone.mark).toContain("lucide-smartphone");
    const desktop = linkStart("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36");
    expect(desktop.label).toBe("这台设备");
    // Not the monitor: that one marks the computer at the other end of the link.
    expect(desktop.mark).toContain("lucide-laptop");
  } finally {
    // Drop the override; the realm's own user agent shows through again.
    delete (navigator as { userAgent?: string }).userAgent;
  }
});
