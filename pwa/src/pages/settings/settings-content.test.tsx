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
 * root, state facade, paint helper or old react wrapper — and unmounts after
 * the assertions. Assertion kept from the former ui/react settings fixture.
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
  expect(host.querySelector(".set-heading .set-title")?.textContent).toBe("连接");
  expect(host.querySelector(".set-heading")).toBeTruthy();
});
