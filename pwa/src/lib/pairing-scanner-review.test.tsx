import { happy, resetTestDOM } from "../../test-support/boot-dom";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { openPairingScanner, type ScannerFactory } from "./pairing-scanner-view";
import { parsePairingURL, type FragmentPairing } from "./pairing-input";
import { setLang, t } from "./i18n";

const origin = "https://pairfob.com";
const qr = `${origin}/pair#v=2&d=d_0123456789abcdefabcd&r=4f7a2c9e1b0d88aa55cc3311abde7001&c=7K3M-9H2P&fp=AAAAAAAAAAAAAAAAAAAAAA`;
const cleanups: Array<() => void> = [];

beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await act(async () => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.scanner-modal")) dialog.close();
  });
});

function pendingCamera() {
  let decode!: (value: string) => void;
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const permission = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const calls = { start: 0, stop: 0, destroy: 0 };
  const factory: ScannerFactory = (_video, onDecode) => {
    decode = onDecode;
    return {
      start() { calls.start++; return permission; },
      stop() { calls.stop++; },
      destroy() { calls.destroy++; },
    };
  };
  return { factory, calls, decode: (value: string) => decode(value), resolve, reject };
}

function open(factory: ScannerFactory) {
  let result!: Promise<FragmentPairing | null>;
  act(() => { result = openPairingScanner(origin, factory); });
  const dialog = [...document.querySelectorAll<HTMLDialogElement>("dialog.scanner-modal")].at(-1)!;
  return { dialog, result };
}

test.each(["constructor", "start"] as const)("synchronous %s failure preserves the legacy rejection while releasing the portal", async stage => {
  const failure = Object.assign(new Error("worker construction failed"), { name: "SecurityError" });
  let destroys = 0;
  const factory: ScannerFactory = () => {
    if (stage === "constructor") throw failure;
    return {
      start() { throw failure; },
      stop() {},
      destroy() { destroys++; },
    };
  };
  let outcome!: Promise<unknown>;
  await act(async () => { outcome = openPairingScanner(origin, factory).catch(error => error); });
  const rejection = await outcome;
  // HEAD rejected the thrown value itself, so connect rendered err.scanFailed.
  expect(rejection === failure).toBeTrue();
  expect(document.querySelector("dialog.scanner-modal")).toBeNull();
  expect(destroys).toBe(stage === "start" ? 1 : 0);
});

test.each([["normal motion", false], ["reduced motion", true]] as const)("hit delay is exact for %s and acknowledges once", async (_label, reduced) => {
  const camera = pendingCamera();
  const { dialog, result } = open(camera.factory);
  const nativeMatch = globalThis.matchMedia;
  const media = spyOn(globalThis, "matchMedia").mockImplementation(query => {
    const answer = Object.create(nativeMatch(query)) as MediaQueryList;
    if (query === "(prefers-reduced-motion: reduce)") Object.defineProperty(answer, "matches", { configurable: true, value: reduced });
    return answer;
  });
  cleanups.push(() => media.mockRestore());
  const vibrateDescriptor = Object.getOwnPropertyDescriptor(navigator, "vibrate");
  const vibrations: number[] = [];
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: (duration: number) => { vibrations.push(duration); return true; } });
  cleanups.push(() => {
    if (vibrateDescriptor) Object.defineProperty(navigator, "vibrate", vibrateDescriptor);
    else Reflect.deleteProperty(navigator, "vibrate");
  });
  const timers: Array<{ callback: () => void; delay: number | undefined }> = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
    timers.push({ callback, delay });
    return 8675309;
  }) as typeof setTimeout);
  cleanups.push(() => timer.mockRestore());
  act(() => { camera.decode(qr); camera.decode(qr); camera.decode("late invalid QR"); });
  expect(timers.map(item => item.delay)).toEqual([reduced ? 0 : 180]);
  expect(vibrations).toEqual([12]);
  expect(camera.calls).toEqual({ start: 1, stop: 1, destroy: 0 });
  expect(dialog.querySelector(".scanner-guide")?.classList.contains("is-hit")).toBeTrue();
  expect(dialog.querySelector("[role=alert]")?.textContent).toBe("");
  timer.mockRestore();
  act(() => timers[0]!.callback());
  expect(await result).toEqual(parsePairingURL(qr, origin));
  expect(camera.calls.destroy).toBe(1);
  expect(dialog.isConnected).toBeFalse();
  await act(async () => { camera.resolve(); timers[0]!.callback(); camera.decode(qr); });
  expect(camera.calls).toEqual({ start: 1, stop: 1, destroy: 1 });
});

test("cancel retires the camera before queued native close and late permission cannot affect a replacement", async () => {
  const queued: HTMLDialogElement[] = [];
  const close = spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement, value?: string) {
    if (!this.open) return;
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    queued.push(this);
  });
  cleanups.push(() => close.mockRestore());
  const first = pendingCamera();
  const old = open(first.factory);
  let settled = false;
  void old.result.then(() => { settled = true; });
  const cancel = new happy.Event("cancel", { cancelable: true });
  act(() => old.dialog.dispatchEvent(cancel as unknown as Event));
  expect(cancel.defaultPrevented).toBeTrue();
  expect(first.calls.destroy).toBe(1);
  expect(old.dialog.open).toBeFalse();
  expect(old.dialog.isConnected).toBeTrue();
  expect(queued.length).toBe(1);
  await Promise.resolve();
  expect(settled).toBeFalse();

  const next = pendingCamera();
  const current = open(next.factory);
  await act(async () => {
    first.reject(new Error("late permission failure"));
    first.decode(qr);
    old.dialog.dispatchEvent(new happy.Event("close") as unknown as Event);
  });
  expect(await old.result).toBeNull();
  expect(first.calls).toEqual({ start: 1, stop: 0, destroy: 1 });
  expect(old.dialog.isConnected).toBeFalse();
  expect(current.dialog.open).toBeTrue();
  expect(current.dialog.isConnected).toBeTrue();
  expect(next.calls).toEqual({ start: 1, stop: 0, destroy: 0 });
  expect(current.dialog.querySelector("[role=alert]")?.textContent).toBe("");
  close.mockRestore();
  await act(async () => current.dialog.querySelector<HTMLButtonElement>("button")!.click());
  expect(await current.result).toBeNull();
  expect(next.calls.destroy).toBe(1);
});

test("scanner rejects changed origins, paths and query material without changing the video, then accepts the relative pair URL", async () => {
  const camera = pendingCamera();
  const { dialog, result } = open(camera.factory);
  const video = dialog.querySelector("video");
  for (const rejected of [qr.replace(origin, "http://pairfob.com"), qr.replace(origin, "https://pairfob.com:8443"), qr.replace("/pair#", "/other#"), qr.replace("/pair#", "/pair?source=qr#"), qr.replace("&fp=AAAAAAAAAAAAAAAAAAAAAA", "")]) {
    act(() => camera.decode(rejected));
    expect(dialog.querySelector("[role=alert]")?.textContent).toBe(t("scan.wrongSite"));
    expect(dialog.querySelector("video") === video).toBeTrue();
    expect(camera.calls.stop).toBe(0);
  }
  act(() => camera.decode(qr.slice(origin.length)));
  expect(dialog.querySelector(".scanner-guide")?.classList.contains("is-hit")).toBeTrue();
  expect(camera.calls.stop).toBe(1);
  await act(async () => dialog.querySelector<HTMLButtonElement>("button")!.click());
  expect(await result).toBeNull();
  expect(camera.calls.destroy).toBe(1);
});
