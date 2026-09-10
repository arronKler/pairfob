import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import { selectPane } from "../session-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { bindKeyPress, dropQueuedKeys } from "./keys.ts";
import type { LiveSession } from "../../../lib/protocol/session-types";

/**
 * A background render (reconnect, mutation error, operation state change)
 * replaces the dock while a key is held. The detached button never receives
 * pointerup - pointer capture is released to the document on removal - so its
 * repeat interval must stop itself instead of flooding the PTY forever.
 */
describe("key auto-repeat stops when its button leaves the DOM", () => {
  test("a mid-hold re-render cannot leave the interval running", async () => {
    const sent: string[][] = [];
    selectPane("p1");
    attachLiveSession({
      isConnected: () => true,
      paneRead: async () => ({ text: "", hash: "" }),
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as unknown as LiveSession);

    const host = happy.document.createElement("div");
    const key = happy.document.createElement("button");
    host.appendChild(key);
    appRoot().appendChild(host);
    bindKeyPress(key, "down", true);

    key.dispatchEvent(new happy.PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 480));
    expect(sent.length).toBeGreaterThanOrEqual(1);

    appRoot().replaceChildren(happy.document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = sent.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sent.length).toBe(settled);
  });
});

afterEach(() => {
  dropQueuedKeys();
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
  appRoot().replaceChildren();
});