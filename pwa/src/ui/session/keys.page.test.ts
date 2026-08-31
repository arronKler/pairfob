import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.performance = happy.performance;
happy.document.body.innerHTML = '<main id="app"></main>';

const { PANE_PAGE_PERF_EVENT } = await import("../../pane-page-perf.ts");
const { bindPaneRefresh } = await import("../../pane-refresh-request.ts");
const { app, state } = await import("../../state.ts");
const { sendPage, syncPagePending } = await import("./keys.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  bindPaneRefresh(async () => null);
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.fullTerminal = false;
  app.replaceChildren();
});

describe("guided page-key feedback", () => {
  test("stays visibly busy until the changed screen is confirmed", async () => {
    app.innerHTML = '<div class="full-terminal-scroll"><button class="scroll-page-up"></button><button class="scroll-page-down"></button></div>';
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

    const page = sendPage("up");
    await Promise.resolve();
    const up = app.querySelector(".scroll-page-up");
    expect(up?.getAttribute("aria-busy")).toBe("true");
    expect(up?.classList.contains("is-pending")).toBeTrue();
    expect(app.querySelector(".full-terminal-scroll")?.getAttribute("aria-busy")).toBe("true");

    mutation.resolve();
    await page;
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
    app.innerHTML = '<div class="full-terminal-scroll"><button class="scroll-page-up"></button></div>';
    const page = sendPage("up");
    await Promise.resolve();
    expect(app.querySelector(".scroll-page-up")?.getAttribute("aria-busy")).toBe("true");

    state.paneId = "p2";
    app.innerHTML = '<div class="full-terminal-scroll"><button class="scroll-page-up"></button></div>';
    syncPagePending();
    expect(app.querySelector(".scroll-page-up")?.hasAttribute("aria-busy")).toBeFalse();

    mutation.resolve();
    await page;
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

    const page = sendPage("down");
    await Promise.resolve();
    expect(order).toEqual(["mutation", "read"]);
    mutation.resolve();
    await page;
  });
});
