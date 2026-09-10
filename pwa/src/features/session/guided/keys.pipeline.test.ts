import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.performance = happy.performance;
happy.document.body.innerHTML = '<main id="app"></main>';

const { bindPaneRefresh } = await import("../../../features/connection/refresh-request.ts");
const { setScreen } = await import("../../../app/navigation-store.ts");
const { selectPane } = await import("../session-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { dropQueuedKeys, queueKey } = await import("./keys.ts");
import type { LiveSession } from "../../../lib/protocol/session-types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  dropQueuedKeys();
  bindPaneRefresh(async () => null);
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
});

describe("guided key latency", () => {
  test("sends the first key immediately and pipelines its ordered pane read", async () => {
    const mutation = deferred<unknown>();
    const order: string[] = [];
    setScreen("pane");
    selectPane("p1");
    attachLiveSession({
      isConnected: () => true,
      sendKeys: (_paneId: string, keys: string[]) => {
        order.push(`send:${keys.join(",")}`);
        return mutation.promise;
      },
    } as unknown as LiveSession);
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