import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.performance = happy.performance;
happy.document.body.innerHTML = '<main id="app"></main>';

const { bindPaneRefresh } = await import("../../pane-refresh-request.ts");
const { state } = await import("../../state.ts");
const { dropQueuedKeys, queueKey } = await import("./keys.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  dropQueuedKeys();
  bindPaneRefresh(async () => null);
  state.live = null;
  state.paneId = "";
  state.screen = "home";
});

describe("guided key latency", () => {
  test("sends the first key immediately and pipelines its ordered pane read", async () => {
    const mutation = deferred<unknown>();
    const order: string[] = [];
    state.screen = "pane";
    state.paneId = "p1";
    state.live = {
      isConnected: () => true,
      sendKeys: (_paneId: string, keys: string[]) => {
        order.push(`send:${keys.join(",")}`);
        return mutation.promise;
      },
    };
    bindPaneRefresh(async (request) => {
      order.push(`read:${request?.postponeFallback === true}:${typeof request?.notBefore === "number"}`);
      return null;
    });

    queueKey("enter");
    expect(order).toEqual(["send:enter", "read:true:true"]);

    mutation.resolve(undefined);
    await mutation.promise;
  });
});
