import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";

const { clearNotice } = await import("../../../app/notices-store.ts");
const { setOperationBusy } = await import("../../operations/capabilities-store.ts");
const { setLang, t } = await import("../../../lib/i18n.ts");
const { SessionActions } = await import("./session-chrome.tsx");

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
  setLang("zh");
  clearNotice();
  setOperationBusy(false);
});

afterEach(() => {
  unmountReact();
  setOperationBusy(false);
  clearNotice();
  appRoot().replaceChildren();
});

describe("workspace chrome entry", () => {
  test("is available by default before more", () => {
    renderReact(createElement(SessionActions, {
      onWorkspace: () => undefined,
      onMenu: () => undefined,
      onStop: () => undefined,
      working: false,
    }));
    const cluster = appRoot().querySelector(".chrome-actions")!;
    expect(cluster.querySelector(".icon-workspace")?.getAttribute("aria-label")).toBe(t("workspace.open"));
    expect(cluster.querySelectorAll("button")).toHaveLength(2);
    expect(cluster.firstElementChild?.classList.contains("icon-workspace")).toBeTrue();
    expect(cluster.querySelector(".icon-stop")).toBeNull();
  });
});