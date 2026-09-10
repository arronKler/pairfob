import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { FullTerminalStateLayer } from "./full-terminal-state-layer";
import { publishFullTerminalView, resetFullTerminalView, type FullTerminalViewSnapshot } from "./full-terminal-view";

const { FullTerminalStatus } = await import("./full-terminal-state.ts");

let retries = 0;

function snap(partial: Partial<FullTerminalViewSnapshot>): FullTerminalViewSnapshot {
  return {
    owner: "test",
    paneId: "p1",
    title: "terminal",
    working: false,
    stage: "loading",
    detail: "",
    retry: false,
    busy: false,
    composeLive: false,
    keyboardOpen: false,
    ...partial,
  };
}

function paint() {
  renderReact(createElement(FullTerminalStateLayer, { onRetry: () => retries++ }));
}

beforeAll(() => {
  document.documentElement.lang = "zh-CN";
});

beforeEach(async () => {
  retries = 0;
  await resetBoardTestDOM();
  resetFullTerminalView();
});

afterEach(async () => {
  unmountReact();
  resetFullTerminalView();
  appRoot().replaceChildren();
});

describe("full terminal centered state", () => {
  test("shows a polite loading state with prominent detail", () => {
    paint();
    act(() => {
      publishFullTerminalView(snap({
        stage: "loading",
        detail: "正在准备终端组件并建立加密连接…",
        retry: false,
        busy: true,
      }));
    });

    const layer = appRoot().querySelector<HTMLElement>(".full-terminal-state")!;
    expect(layer.hidden).toBe(false);
    expect(layer.dataset.stage).toBe("loading");
    expect(layer.getAttribute("role")).toBe("status");
    expect(layer.getAttribute("aria-live")).toBe("polite");
    expect(appRoot().querySelector(".full-terminal-state-title")?.textContent).toBe("正在载入会话终端");
    expect(appRoot().querySelector(".full-terminal-state-detail")?.textContent).toContain("建立加密连接");
    expect(appRoot().querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBe(true);
  });

  test("announces an error and exposes a working retry button", () => {
    paint();
    act(() => {
      publishFullTerminalView(snap({
        stage: "error",
        detail: "无法打开终端：连接超时",
        retry: true,
        busy: false,
      }));
    });

    const layer = appRoot().querySelector<HTMLElement>(".full-terminal-state")!;
    const retry = appRoot().querySelector<HTMLButtonElement>(".full-terminal-state-retry")!;
    expect(layer.getAttribute("role")).toBe("alert");
    expect(layer.getAttribute("aria-live")).toBe("assertive");
    expect(appRoot().querySelector(".full-terminal-state-title")?.textContent).toBe("无法打开会话终端");
    expect(retry.hidden).toBe(false);
    act(() => { retry.click(); });
    expect(retries).toBe(1);
  });

  test("hides the state layer once the terminal is live", () => {
    paint();
    act(() => {
      publishFullTerminalView(snap({
        stage: "live",
        detail: "实时 · 端到端加密",
        retry: false,
        busy: false,
      }));
    });

    expect(appRoot().querySelector<HTMLElement>(".full-terminal-state")?.hidden).toBe(true);
  });

  test("owns loading, retry, and repaint state for the terminal lifecycle", () => {
    let paints = 0;
    const status = new FullTerminalStatus(() => paints++);
    status.reset("正在准备");
    status.fail("连接超时");
    expect(paints).toBe(2);
    expect(status.retry).toBeTrue();
    expect(status.detail).toBe("连接超时");
    expect(status.stage).toBe("error");
    status.wait("等待恢复");
    expect(status.retry).toBeFalse();
    expect(status.detail).toBe("等待恢复");
    expect(status.stage).toBe("waiting");
  });
});