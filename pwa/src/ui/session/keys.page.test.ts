import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { leaveReactScreen, renderReactScreen } from "../react/root";
import { SessionScrollRail } from "../react/session-scroll";

const { PANE_PAGE_PERF_EVENT } = await import("../../pane-page-perf.ts");
const { bindPaneRefresh } = await import("../../pane-refresh-request.ts");
const { app, state } = await import("../../state.ts");
const { sendPage, syncPagePending } = await import("./keys.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  await resetTestDOM();
  act(leaveReactScreen);
});

afterEach(() => {
  act(leaveReactScreen);
  bindPaneRefresh(async () => null);
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.fullTerminal = false;
  app.replaceChildren();
});

function paintRail(): void {
  act(() => renderReactScreen(createElement(SessionScrollRail, {
    scroll: direction => void sendPage(direction),
    pageLines: () => 23,
  })));
}

describe("guided page-key feedback", () => {
  test("stays visibly busy until the changed screen is confirmed", async () => {
    const mutation = deferred<void>();
    state.screen = "pane";
    state.paneId = "p1";
    state.paneText = "before";
    state.paneHash = "old";
    state.fullTerminal = false;
    state.live = {
      sendText: async () => mutation.promise,
      isConnected: () => true,
    };
    bindPaneRefresh(async () => ({
      paneId: "p1", text: "after", hash: "new", changed: true,
      startedAt: performance.now(), completedAt: performance.now(),
    }));
    const samples: unknown[] = [];
    document.addEventListener(PANE_PAGE_PERF_EVENT, (event) => samples.push((event as CustomEvent).detail), { once: true });

    paintRail();
    let page!: Promise<void>;
    await act(async () => { page = sendPage("up"); await Promise.resolve(); });
    const up = app.querySelector(".scroll-page-up");
    expect(up?.getAttribute("aria-busy")).toBe("true");
    expect(up?.classList.contains("is-pending")).toBeTrue();
    expect(app.querySelector(".full-terminal-scroll")?.getAttribute("aria-busy")).toBe("true");

    await act(async () => { mutation.resolve(); await page; });
    expect(up?.hasAttribute("aria-busy")).toBeFalse();
    expect(up?.classList.contains("is-pending")).toBeFalse();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ direction: "up", result: "changed", attempts: 1 });
  });

  test("does not carry one pane's pending state onto another pane", async () => {
    const mutation = deferred<void>();
    state.screen = "pane";
    state.paneId = "p1";
    state.paneText = "before";
    state.paneHash = "old";
    state.live = {
      sendText: async () => mutation.promise,
      isConnected: () => true,
    };
    bindPaneRefresh(async () => ({
      paneId: "p1", text: "after", hash: "new", changed: true,
      startedAt: performance.now(), completedAt: performance.now(),
    }));
    paintRail();
    let page!: Promise<void>;
    await act(async () => { page = sendPage("up"); await Promise.resolve(); });
    expect(app.querySelector(".scroll-page-up")?.getAttribute("aria-busy")).toBe("true");

    state.paneId = "p2";
    paintRail();
    act(syncPagePending);
    expect(app.querySelector(".scroll-page-up")?.hasAttribute("aria-busy")).toBeFalse();

    await act(async () => { mutation.resolve(); await page; });
  });

  test("pipelines the first confirmation read behind the mutation frame", async () => {
    const mutation = deferred<void>();
    const order: string[] = [];
    state.screen = "pane";
    state.paneId = "p1";
    state.paneText = "before";
    state.paneHash = "old";
    state.live = {
      sendText: async () => {
        order.push("mutation");
        return mutation.promise;
      },
      isConnected: () => true,
    };
    bindPaneRefresh(async () => {
      order.push("read");
      return {
        paneId: "p1", text: "after", hash: "new", changed: true,
        startedAt: performance.now(), completedAt: performance.now(),
      };
    });

    paintRail();
    let page!: Promise<void>;
    await act(async () => { page = sendPage("down"); await Promise.resolve(); });
    expect(order).toEqual(["mutation", "read"]);
    await act(async () => { mutation.resolve(); await page; });
  });
});
