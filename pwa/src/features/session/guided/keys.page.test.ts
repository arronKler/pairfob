import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import { selectPane, applyPaneRead, setFullTerminal } from "../session-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { SessionScrollRail } from "./session-scroll";
import type { LiveSession } from "../../../lib/protocol/session-types";

const { PANE_PAGE_PERF_EVENT } = await import("../../../features/connection/pane-page-perf.ts");
const { bindPaneRefresh } = await import("../../../features/connection/refresh-request.ts");
const { sendPage, syncPagePending } = await import("./keys.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  await resetTestDOM();
  unmountReact();
});

afterEach(() => {
  unmountReact();
  bindPaneRefresh(async () => null);
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
  setFullTerminal(false);
  appRoot().replaceChildren();
});

function paintRail(): void {
  renderReact(createElement(SessionScrollRail, {
    scroll: direction => void sendPage(direction),
    pageLines: () => 23,
  }));
}

describe("guided page-key feedback", () => {
  test("stays visibly busy until the changed screen is confirmed", async () => {
    const mutation = deferred<void>();
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("before", "old");
    setFullTerminal(false);
    bindPaneRefresh(async () => ({
      paneId: "p1", text: "after", hash: "new", changed: true,
      startedAt: performance.now(), completedAt: performance.now(),
    }));
    attachLiveSession({
      sendText: async (_paneId: string, _text: string) => mutation.promise,
      isConnected: () => true,
    } as unknown as LiveSession);
    const samples: unknown[] = [];
    document.addEventListener(PANE_PAGE_PERF_EVENT, (event) => samples.push((event as CustomEvent).detail), { once: true });

    paintRail();
    let page!: Promise<void>;
    await act(async () => { page = sendPage("up"); await Promise.resolve(); });
    const up = appRoot().querySelector(".scroll-page-up");
    expect(up?.getAttribute("aria-busy")).toBe("true");
    expect(up?.classList.contains("is-pending")).toBeTrue();
    expect(appRoot().querySelector(".full-terminal-scroll")?.getAttribute("aria-busy")).toBe("true");

    await act(async () => { mutation.resolve(); await page; });
    expect(up?.hasAttribute("aria-busy")).toBeFalse();
    expect(up?.classList.contains("is-pending")).toBeFalse();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ direction: "up", result: "changed", attempts: 1 });
  });

  test("does not carry one pane's pending state onto another pane", async () => {
    const mutation = deferred<void>();
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("before", "old");
    attachLiveSession({
      sendText: async (_paneId: string, _text: string) => mutation.promise,
      isConnected: () => true,
    } as unknown as LiveSession);
    bindPaneRefresh(async () => ({
      paneId: "p1", text: "after", hash: "new", changed: true,
      startedAt: performance.now(), completedAt: performance.now(),
    }));
    paintRail();
    let page!: Promise<void>;
    await act(async () => { page = sendPage("up"); await Promise.resolve(); });
    expect(appRoot().querySelector(".scroll-page-up")?.getAttribute("aria-busy")).toBe("true");

    act(() => { selectPane("p2"); });
    paintRail();
    act(syncPagePending);
    expect(appRoot().querySelector(".scroll-page-up")?.hasAttribute("aria-busy")).toBeFalse();

    await act(async () => { mutation.resolve(); await page; });
  });

  test("pipelines the first confirmation read behind the mutation frame", async () => {
    const mutation = deferred<void>();
    const order: string[] = [];
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("before", "old");
    attachLiveSession({
      sendText: async (_paneId: string, _text: string) => {
        order.push("mutation");
        return mutation.promise;
      },
      isConnected: () => true,
    } as unknown as LiveSession);
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