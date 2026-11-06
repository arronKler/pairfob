import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachHappyDom, leaveReactScreen, renderReactScreen } from "../../../test-support/react-dom";
import { NotificationItem } from "./settings-notifications";
import { setLang } from "../../lib/i18n";

attachHappyDom();
setLang("zh");

type Port = {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
};

function nativeFixture(permission: "granted" | "denied" | "prompt") {
  const requests: Array<{ method: string }> = [];
  const port: Port = {
    postMessage(raw) {
      const request = JSON.parse(raw) as { id: string; method: string };
      requests.push(request);
      const value = request.method === "status" ? { permission, backgroundSync: false }
        : request.method === "requestPermission" ? { permission }
        : request.method === "setBackgroundSync" ? { backgroundSync: true }
        : request.method === "cancelAll" ? {}
        : { posted: true };
      port.onmessage?.({ data: JSON.stringify({ id: request.id, ok: true, value }) });
    },
    onmessage: null,
  };
  (window as unknown as { PairfobNotify?: Port }).PairfobNotify = port;
  return { port, requests };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function host(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

function button(text: string, root: HTMLElement): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  leaveReactScreen();
  delete (window as unknown as { PairfobNotify?: unknown }).PairfobNotify;
  localStorage.clear();
});

describe("native notification row", () => {
  test("turning on shows the green state and the background sync explanation, and the same control turns it off", async () => {
    const { requests } = nativeFixture("granted");
    const root = host();
    renderReactScreen(root, <NotificationItem input={{ channel: "native" }} />);
    await settle();
    expect(root.querySelector(".notification-sync")).toBeNull();
    const enable = button("开启", root);
    expect(enable).toBeDefined();
    act(() => enable!.click());
    await settle();
    expect(button("已开启", root)).toBeDefined();
    const fold = root.querySelector<HTMLElement>(".notification-item .fold");
    expect(fold?.classList.contains("is-shut")).toBe(false);
    expect(root.textContent).toContain("每 15 分钟左右会在后台连一次电脑");
    act(() => button("已开启", root)!.click());
    await settle();
    expect(button("开启", root)).toBeDefined();
    expect(requests.some((request) => request.method === "cancelAll")).toBeTrue();
  });

  test("a denied permission explains the Android setting and offers no dead button", async () => {
    nativeFixture("denied");
    const root = host();
    renderReactScreen(root, <NotificationItem input={{ channel: "native" }} />);
    await settle();
    expect(root.querySelector(".set-item-sub")?.textContent).toContain("系统设置");
    expect(root.querySelector(".set-state")?.textContent).toBe("已拒绝");
    expect(button("开启", root)).toBeUndefined();
  });

  test("an iPhone reads iOS copy for the permission and the background schedule", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    });
    try {
      nativeFixture("denied");
      const denied = host();
      renderReactScreen(denied, <NotificationItem input={{ channel: "native" }} />);
      await settle();
      expect(denied.querySelector(".set-item-sub")?.textContent).toContain("iOS");
      leaveReactScreen();

      nativeFixture("granted");
      const allowed = host();
      renderReactScreen(allowed, <NotificationItem input={{ channel: "native" }} />);
      await settle();
      act(() => button("开启", allowed)!.click());
      await settle();
      expect(allowed.textContent).toContain("iOS 会按使用习惯决定何时运行");
    } finally {
      if (original) Object.defineProperty(navigator, "userAgent", original);
      else delete (navigator as unknown as Record<string, unknown>).userAgent;
    }
  });
});
