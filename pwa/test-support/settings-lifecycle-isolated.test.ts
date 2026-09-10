/**
 * Runs in its OWN bun test process (spawned from
 * src/pages/settings/settings-lifecycle.test.tsx).
 *
 * This file intentionally lives in test-support/ so `bun test src` never
 * collects it. The release-check fixture runs real `checkDaemonRelease` /
 * `refreshDaemonUpdate` calls against the shared daemon-update model, whose
 * private per-daemon views and global latest/next-check state have no restore
 * API. Executing it here keeps every one of those mutations inside this child
 * process, so the parent worker and its sibling settings suites never see them.
 * No production function is mocked; the case bodies below are the original four
 * tests with the existing React harness and named owners.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { resetBoardTestDOM } from "./dom";
import { renderReact, unmountReact } from "./react-harness";
import { appRoot } from "../src/app/dom-root";
import { appHost, registerAppHost, releaseAppHost } from "../src/app/host";
import { lang, setLang, t } from "../src/lib/i18n";
import type { LiveSession } from "../src/lib/protocol/session-types";
import { setPhase } from "../src/features/connection/connection-store";
import { setScreen } from "../src/app/navigation-store";
import {
  attachLiveSession,
  credential,
  lastUsedDaemon,
  liveSession,
  setCredential,
  setLastUsedDaemon,
} from "../src/features/computers/catalog-store";
import { clearNotice, showError, showStatus, visibleNotice } from "../src/app/notices-store";
import {
  acceptDaemonVersion,
  checkDaemonRelease,
  daemonVersion,
  refreshDaemonUpdate,
  type DaemonVersion,
} from "../src/features/settings/daemon-update";
import { DaemonUpdate, ManualUpdateHelp } from "../src/features/settings/daemon-update-view";
import { SettingsScreen } from "../src/pages/settings/settings-page";

let serial = 0;
// Preimage captures of every actual mutator these four cases touch (lang, fetch,
// the global localStorage descriptor, session, credential + last-used ownership,
// the daemon-update model and the notice). Captured per case entry and restored
// in afterEach so foreign domains/subscribers are preserved, never blanket-reset.
let preLang: ReturnType<typeof lang> = "zh";
let preFetch: typeof fetch = fetch;
let preStorageDescriptor: PropertyDescriptor | undefined;
let preLive: LiveSession | null = null;
let preCredential: ReturnType<typeof credential> = null;
let preLastUsed: string | null = null;
let preViewFields: DaemonVersion | undefined;
let preNotice: ReturnType<typeof visibleNotice> = null;

const render = (component: typeof ManualUpdateHelp | typeof SettingsScreen | typeof DaemonUpdate, props = {}) => renderReact(createElement(component, props));
async function connect(): Promise<void> {
  setPhase("live");
  setScreen("settings");
  setCredential({ daemonId: `review-${++serial}` } as never);
  attachLiveSession({
    isConnected: () => true,
    daemonUpdateStatus: async () => ({ available: true, phase: "idle", target: "", operation_id: "" }),
  } as unknown as LiveSession);
  globalThis.fetch = (async () => new Response("1.1.0")) as typeof fetch;
  await act(async () => {
    await acceptDaemonVersion({ build: "1.0.0" });
    await checkDaemonRelease(true);
    await refreshDaemonUpdate();
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  preLang = lang();
  preFetch = globalThis.fetch;
  preStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  preLive = liveSession();
  preCredential = credential();
  preLastUsed = lastUsedDaemon();
  const view = daemonVersion();
  preViewFields = view ? { ...view } : undefined;
  preNotice = visibleNotice();
});

afterEach(() => {
  unmountReact();
  globalThis.fetch = preFetch;
  if (preStorageDescriptor) Object.defineProperty(globalThis, "localStorage", preStorageDescriptor);
  setLang(preLang);
  attachLiveSession(preLive);
  setCredential(preCredential);
  setLastUsedDaemon(preLastUsed);
  const currentView = daemonVersion();
  if (currentView && preViewFields) Object.assign(currentView, preViewFields);
  const noticeNow = visibleNotice();
  if (noticeNow) clearNotice();
  if (preNotice) {
    // Preserve a foreign notice's text, tone and scope through the existing
    // notice API. The original dismiss-timer deadline is not recoverable, so the
    // notice is kept until the next action; no new notice API is invented.
    if (preNotice.tone === "error") showError(preNotice.text, preNotice.scope, true);
    else showStatus(preNotice.text, true, preNotice.scope);
  }
});

test("persistent manual copy label follows language repaint", () => {
  act(() => setLang("zh"));
  act(() => render(ManualUpdateHelp));
  const before = appRoot().querySelector("button")!;
  expect(before.textContent).toBe(t("update.copyCommand"));
  act(() => setLang("en"));
  act(() => render(ManualUpdateHelp));
  expect(appRoot().querySelector("button") === before).toBeTrue();
  expect(before.textContent).toBe(t("update.copyCommand"));
});

test("compact later hides even if browser storage is unavailable", async () => {
  await connect();
  const paint = () => render(DaemonUpdate, { compact: true });
  act(paint);
  expect(appRoot().querySelector("section.daemon-update")).not.toBeNull();
  // Intercept the global localStorage descriptor with a forwarding proxy: only
  // setItem throws (proving the postpone catch path actually runs), while every
  // other method binds to and forwards to the original storage. Happy DOM caches
  // the prototype Storage getter, so replacing the prototype descriptor alone
  // does not take effect; the scoped global-descriptor swap is restored in
  // finally and never touches the shared prototype.
  const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  const originalStorage = localStorage;
  const failingStorage: Storage = new Proxy(originalStorage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "setItem") {
        return () => { throw new Error("storage unavailable"); };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  Object.defineProperty(globalThis, "localStorage", { ...originalStorageDescriptor, value: failingStorage, configurable: true });
  try {
    const later = [...appRoot().querySelectorAll("button")].find((b) => b.textContent === t("update.later"))!;
    act(() => later.click());
    expect(appRoot().querySelector("section.daemon-update") === null).toBeTrue();
    expect(appRoot().querySelector<HTMLElement>(".daemon-update-host")?.hidden).toBeTrue();
  } finally {
    Object.defineProperty(globalThis, "localStorage", originalStorageDescriptor);
  }
});

test("persistent settings notice updates and clears through real subscription", () => {
  attachLiveSession(null);
  setScreen("settings");
  clearNotice();
  act(() => render(SettingsScreen));
  const page = appRoot().firstElementChild;
  act(() => showStatus("review status"));
  expect(appRoot().querySelector("[data-react-notice]")?.textContent).toBe("review status");
  expect(appRoot().firstElementChild === page).toBeTrue();
  act(() => clearNotice());
  expect(appRoot().querySelector("[data-react-notice]")).toBeNull();
});

test("daemon release check updates the mounted subtree without repainting the app", async () => {
  await connect();
  // Bounded recording host on the real registry seam: the daemon-release window
  // must not drive a whole-App commit. The component-root boundary renders the
  // subscribed subtree directly, so a zero commit/requestCommit count proves no
  // whole-App repaint. The prior host (or null) is restored in finally, and a
  // host that was replaced meanwhile is never overwritten.
  const priorHost = appHost();
  const counts = { commit: 0, requestCommit: 0 };
  const recording = {
    commit() { counts.commit += 1; },
    requestCommit() { counts.requestCommit += 1; },
    unmount() { },
  };
  registerAppHost(recording);
  try {
    act(() => render(DaemonUpdate, {}));
    const host = appRoot().firstElementChild;
    const button = appRoot().querySelector<HTMLButtonElement>(".daemon-update-check")!;
    let finish!: (r: Response) => void;
    globalThis.fetch = (() => new Promise((r) => { finish = r; })) as typeof fetch;
    act(() => button.click());
    expect(appRoot().firstElementChild === host).toBeTrue();
    expect(button.disabled).toBeTrue();
    expect(button.textContent).toContain(t("update.checking"));
    await act(async () => {
      finish(new Response("1.1.0"));
      await checkDaemonRelease();
      await refreshDaemonUpdate();
    });
    expect(appRoot().firstElementChild === host).toBeTrue();
    expect(appRoot().querySelector(".daemon-update-check") === button).toBeTrue();
    expect(button.disabled).toBeFalse();
    expect(appRoot().querySelector(".daemon-update-feedback")?.textContent).toContain("1.1.0");
    // The subtree updated through its own subscription: no whole-App commit.
    expect(counts.commit).toBe(0);
    expect(counts.requestCommit).toBe(0);
  } finally {
    if (appHost() === recording) {
      if (priorHost) registerAppHost(priorHost);
      else releaseAppHost(recording);
    }
  }
});