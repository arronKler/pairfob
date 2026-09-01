import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Node", "DocumentFragment", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { NETWORK_MODE_KEY, app, clearNotice, setNetworkMode, state } = await import("../state.ts");
const { DirectError } = await import("../lib/protocol/direct-peer.ts");
const { setRenderer } = await import("../paint.ts");
const { fillSettings } = await import("./settings.ts");

function paint(): void {
  app.replaceChildren();
  fillSettings(app, false);
}

function group(): HTMLElement {
  const found = app.querySelector('[aria-label="网络连接方式"]');
  if (!(found instanceof HTMLElement)) throw new Error("missing network path control");
  return found;
}

function choice(label: string): HTMLButtonElement {
  const found = [...group().querySelectorAll("button")].find((item) => item.textContent === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return found;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  state.live = null;
  state.p2pEnabled = false;
  state.sessionTransport = "relay";
  state.transportSwitching = false;
  state.relayRttMs = null;
  setNetworkMode("auto");
  localStorage.removeItem(NETWORK_MODE_KEY);
  state.networkMode = "auto";
  state.lastP2PAttempt = null;
  clearNotice();
  app.replaceChildren();
});

describe("settings network transport", () => {
  test("offers Auto, P2P, and Relay, then persists a manual Relay pin", async () => {
    const targets: Array<"auto" | "relay" | "p2p"> = [];
    state.p2pEnabled = true;
    state.sessionTransport = "p2p";
    state.relayRttMs = 18;
    state.live = {
      isConnected: () => true,
      switchTransport: async (target: "auto" | "relay" | "p2p") => {
        targets.push(target);
        if (target === "relay") state.sessionTransport = "relay";
        if (target === "p2p") state.sessionTransport = "p2p";
      },
    } as typeof state.live;
    setRenderer(paint);
    paint();

    expect(app.textContent).toContain("P2P 直连 · 18 毫秒");
    expect([...group().querySelectorAll("button")].map((item) => item.textContent)).toEqual(["自动", "P2P", "Relay"]);
    expect(group().querySelector('[aria-checked="true"]')?.textContent).toBe("自动");

    choice("Relay").click();
    await settle();
    expect(targets).toEqual(["relay"]);
    expect(state.networkMode).toBe("relay");
    expect(localStorage.getItem(NETWORK_MODE_KEY)).toBe("relay");
    expect(group().querySelector('[aria-checked="true"]')?.textContent).toBe("Relay");
    expect(choice("自动").disabled).toBeFalse();
  });

  test("a P2P choice requests a direct path; Auto resumes background upgrades", async () => {
    const targets: Array<"auto" | "relay" | "p2p"> = [];
    state.p2pEnabled = true;
    state.networkMode = "relay";
    state.sessionTransport = "relay";
    state.relayRttMs = 42;
    state.live = {
      isConnected: () => true,
      switchTransport: async (target: "auto" | "relay" | "p2p") => {
        targets.push(target);
        if (target === "p2p") state.sessionTransport = "p2p";
      },
    } as typeof state.live;
    setRenderer(paint);
    paint();

    expect(app.textContent).toContain("Relay 中继 · 42 毫秒");
    choice("P2P").click();
    await settle();
    expect(targets).toEqual(["p2p"]);
    expect(state.networkMode).toBe("p2p");
    expect(group().querySelector('[aria-checked="true"]')?.textContent).toBe("P2P");

    choice("自动").click();
    await settle();
    expect(targets).toEqual(["p2p", "auto"]);
    expect(state.networkMode).toBe("auto");
  });

  test("disables P2P when the origin kill switch is off", () => {
    state.p2pEnabled = false;
    state.live = { isConnected: () => true } as typeof state.live;
    setRenderer(paint);
    paint();

    expect(choice("P2P").disabled).toBeTrue();
    expect(choice("自动").disabled).toBeFalse();
    expect(choice("Relay").disabled).toBeFalse();
    expect(app.querySelector(".network-mode-row")?.textContent).toContain("当前站点未开放 P2P");
  });

  test("keeps Relay usable and reports a failed manual P2P attempt", async () => {
    state.p2pEnabled = true;
    state.live = {
      isConnected: () => true,
      switchTransport: async () => { throw new Error("ICE failed"); },
    } as typeof state.live;
    setRenderer(paint);
    paint();

    choice("P2P").click();
    await settle();

    expect(state.sessionTransport).toBe("relay");
    expect(state.networkMode).toBe("p2p");
    expect(state.notice?.text).toContain("已继续使用 Relay");
    expect(group().querySelector('[aria-checked="true"]')?.textContent).toBe("P2P");
    expect(choice("P2P").disabled).toBeFalse();
  });

  test("explains a browser-side ICE timeout without exposing raw network data", async () => {
    state.p2pEnabled = true;
    state.live = {
      isConnected: () => true,
      switchTransport: async () => { throw new DirectError("ice_timeout", "candidate 192.0.2.1 failed"); },
    } as typeof state.live;
    setRenderer(paint);
    paint();

    choice("P2P").click();
    await settle();

    expect(state.notice?.text).toContain("手机浏览器未能收集直连地址");
    expect(state.notice?.text).not.toContain("192.0.2.1");
  });

  test("explains a restored P2P preference while Relay bootstraps or retries", async () => {
    const targets: Array<"auto" | "relay" | "p2p"> = [];
    state.p2pEnabled = true;
    state.networkMode = "p2p";
    state.sessionTransport = "relay";
    state.relayRttMs = 36;
    state.live = {
      isConnected: () => true,
      switchTransport: async (target: "auto" | "relay" | "p2p") => {
        targets.push(target);
      },
    } as typeof state.live;
    setRenderer(paint);
    paint();

    expect(app.textContent).toContain("P2P 优先 · 当前 Relay · 36 毫秒");
    expect(app.querySelector(".network-mode-row")?.textContent).toContain("无需重新切换");
    expect(group().querySelector('[aria-checked="true"]')?.textContent).toBe("P2P");
    choice("P2P").click();
    await settle();
    expect(targets).toEqual(["p2p"]);
  });

  test("shows the last automatic P2P failure on Auto without exposing addresses", () => {
    state.p2pEnabled = true;
    state.networkMode = "auto";
    state.sessionTransport = "relay";
    state.relayRttMs = 24;
    state.lastP2PAttempt = { result: "failed", extra: "ice_timeout" };
    state.live = { isConnected: () => true } as typeof state.live;
    setRenderer(paint);
    paint();

    expect(app.textContent).toContain("Relay 中继 · 24 毫秒");
    expect(app.querySelector(".network-p2p-fail")?.textContent).toContain("手机浏览器未能收集直连地址");
    expect(app.textContent).not.toContain("ice_timeout");
  });
});
