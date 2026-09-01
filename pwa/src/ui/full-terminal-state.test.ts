import { Window } from "happy-dom";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair" });
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "HTMLButtonElement", "Node"] as const) {
  globals[key] = (happy as unknown as Record<string, unknown>)[key];
}

const { FullTerminalStatus, fullTerminalStateLayer, syncFullTerminalState } = await import("./full-terminal-state.ts");

let retries = 0;

function root(): HTMLElement {
  const root = document.createElement("div");
  const header = document.createElement("span");
  header.className = "full-terminal-status";
  root.append(header, fullTerminalStateLayer(() => retries++));
  document.body.append(root);
  return root;
}

beforeAll(() => {
  document.documentElement.lang = "zh-CN";
});

beforeEach(() => {
  retries = 0;
  document.body.replaceChildren();
});

describe("full terminal centered state", () => {
  test("shows a polite loading state with prominent detail", () => {
    const view = root();
    syncFullTerminalState(view, {
      stage: "loading",
      detail: "正在准备终端组件并建立加密连接…",
      retry: false,
      busy: true,
    });

    const state = view.querySelector<HTMLElement>(".full-terminal-state")!;
    expect(state.hidden).toBe(false);
    expect(state.dataset.stage).toBe("loading");
    expect(state.getAttribute("role")).toBe("status");
    expect(state.getAttribute("aria-live")).toBe("polite");
    expect(view.querySelector(".full-terminal-state-title")?.textContent).toBe("正在载入会话终端");
    expect(view.querySelector(".full-terminal-state-detail")?.textContent).toContain("建立加密连接");
    expect(view.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBe(true);
  });

  test("announces an error and exposes a working retry button", () => {
    const view = root();
    syncFullTerminalState(view, {
      stage: "error",
      detail: "无法打开终端：连接超时",
      retry: true,
      busy: false,
    });

    const state = view.querySelector<HTMLElement>(".full-terminal-state")!;
    const retry = view.querySelector<HTMLButtonElement>(".full-terminal-state-retry")!;
    expect(state.getAttribute("role")).toBe("alert");
    expect(state.getAttribute("aria-live")).toBe("assertive");
    expect(view.querySelector(".full-terminal-state-title")?.textContent).toBe("无法打开会话终端");
    expect(retry.hidden).toBe(false);
    retry.click();
    expect(retries).toBe(1);
  });

  test("hides the state layer once the terminal is live", () => {
    const view = root();
    syncFullTerminalState(view, {
      stage: "live",
      detail: "实时 · 端到端加密",
      retry: false,
      busy: false,
    });

    expect(view.querySelector<HTMLElement>(".full-terminal-state")?.hidden).toBe(true);
    expect(view.querySelector(".full-terminal-status")?.textContent).toBe("实时 · 端到端加密");
  });

  test("owns loading, retry, and repaint state for the terminal lifecycle", () => {
    const view = root();
    let paints = 0;
    const status = new FullTerminalStatus(() => paints++);
    status.reset("正在准备");
    status.fail("连接超时");
    status.sync(view, { active: true, busy: false, hasBridge: false });
    expect(paints).toBe(2);
    expect(view.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();
    status.wait("等待恢复");
    status.sync(view, { active: true, busy: false, hasBridge: false });
    expect(view.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeTrue();
    expect(view.querySelector(".full-terminal-status")?.textContent).toBe("等待恢复");
  });
});
