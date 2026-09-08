import { happy, resetTestDOM } from "../../test-support/boot-dom";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { openPairingScanner, PairingScanError, type ScannerFactory } from "./pairing-scanner-view";
import { scanPairingCode } from "./pairing-scanner";
import { parsePairingURL, type FragmentPairing } from "./pairing-input";
import { setLang, t } from "./i18n";

const origin = "https://pairfob.com";
const qr = `${origin}/pair#v=2&d=d_0123456789abcdefabcd&r=4f7a2c9e1b0d88aa55cc3311abde7001&c=7K3M-9H2P&fp=AAAAAAAAAAAAAAAAAAAAAA`;
beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(async () => {
  await act(async () => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.scanner-modal")) dialog.close();
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function camera(start: Promise<void> = Promise.resolve()) {
  let decode!: (data: string) => void;
  let video!: HTMLVideoElement;
  const calls = { create: 0, start: 0, stop: 0, destroy: 0 };
  const factory: ScannerFactory = (element, onDecode) => {
    calls.create++;
    video = element;
    decode = onDecode;
    return {
      start() { calls.start++; return start; },
      stop() { calls.stop++; },
      destroy() { calls.destroy++; },
    };
  };
  return { factory, calls, decode: (value: string) => decode(value), video: () => video };
}
function dialog() { return document.querySelector<HTMLDialogElement>("dialog.scanner-modal")!; }
function open(factory: ScannerFactory) {
  let result!: Promise<FragmentPairing | null>;
  act(() => { result = openPairingScanner(origin, factory); });
  return result;
}

test("scanner preserves the frame, inline error and video identity across a rejected QR", async () => {
  const engine = camera();
  const result = open(engine.factory);
  const modal = dialog();
  const video = engine.video();
  expect(modal.open).toBeTrue();
  expect(modal.getAttribute("aria-labelledby")).toBe("scanner-title");
  expect([...modal.children].map(node => node.tagName)).toEqual(["H2", "P", "DIV", "P", "BUTTON"]);
  expect(modal.querySelectorAll(".scanner-corner")).toHaveLength(4);
  expect(video.hasAttribute("playsinline")).toBeTrue();
  expect(video.muted).toBeTrue();
  await act(async () => engine.decode(qr.replace(origin, "https://example.com")));
  expect(modal.querySelector("[role=alert]")?.textContent).toBe(t("scan.wrongSite"));
  expect(engine.video() === modal.querySelector("video")).toBeTrue();
  expect(engine.calls).toEqual({ create: 1, start: 1, stop: 0, destroy: 0 });
  await act(async () => modal.querySelector<HTMLButtonElement>("button")!.click());
  expect(await result).toBeNull();
  expect(engine.calls.destroy).toBe(1);
});

test("a valid hit stops once, lights the frame, then resolves exact pairing and restores focus", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const engine = camera();
  const result = open(engine.factory);
  await act(async () => { engine.decode(qr); engine.decode(qr); });
  expect(dialog().querySelector(".scanner-guide.is-hit")).not.toBeNull();
  expect(engine.calls.stop).toBe(1);
  expect(engine.calls.destroy).toBe(0);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  expect(await result).toEqual(parsePairingURL(qr, origin));
  expect(dialog()).toBeNull();
  expect(engine.calls.destroy).toBe(1);
  expect(document.activeElement === trigger).toBeTrue();
  trigger.remove();
});

test("cancel during the hit delay wins and retires all later decode callbacks", async () => {
  const engine = camera();
  const result = open(engine.factory);
  await act(async () => engine.decode(qr));
  await act(async () => dialog().querySelector<HTMLButtonElement>("button")!.click());
  expect(await result).toBeNull();
  await act(async () => {
    engine.decode(qr);
    engine.decode("bad");
    await new Promise(resolve => setTimeout(resolve, 200));
  });
  expect(engine.calls).toEqual({ create: 1, start: 1, stop: 1, destroy: 1 });
  expect(dialog()).toBeNull();
});

test("Escape cancels immediately while permission is pending; late rejection is inert", async () => {
  const permission = deferred();
  const engine = camera(permission.promise);
  const result = open(engine.factory);
  const escape = new happy.Event("cancel", { cancelable: true });
  await act(async () => dialog().dispatchEvent(escape as unknown as Event));
  expect(escape.defaultPrevented).toBeTrue();
  expect(await result).toBeNull();
  await act(async () => permission.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })));
  expect(engine.calls.destroy).toBe(1);
  expect(dialog()).toBeNull();
});

test("native close retires a pending engine before a late start/decode result", async () => {
  const permission = deferred();
  const engine = camera(permission.promise);
  const result = open(engine.factory);
  await act(async () => dialog().close());
  expect(await result).toBeNull();
  await act(async () => { permission.resolve(); engine.decode(qr); });
  expect(engine.calls.destroy).toBe(1);
  expect(engine.calls.stop).toBe(0);
});

test.each([
  ["NotAllowedError", "scan.cameraDenied"], ["SecurityError", "scan.cameraDenied"],
  ["NotFoundError", "scan.noCamera"], ["OverconstrainedError", "scan.noCamera"],
  ["UnknownError", "scan.cameraFail"],
] as const)("camera failure %s preserves its actionable error", async (name, key) => {
  const permission = deferred();
  const engine = camera(permission.promise);
  const outcome = open(engine.factory).catch(error => error);
  await act(async () => permission.reject(Object.assign(new Error("camera"), { name })));
  const error = await outcome;
  expect(error).toBeInstanceOf(PairingScanError);
  expect(error.message).toBe(t(key));
  expect(engine.calls.destroy).toBe(1);
  expect(dialog()).toBeNull();
});

test("a dialog that cannot open rejects after commit and never creates a camera", async () => {
  const show = spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(() => { throw new Error("unsupported"); });
  const engine = camera();
  try {
    let outcome!: Promise<unknown>;
    await act(async () => { outcome = openPairingScanner(origin, engine.factory).catch(error => error); });
    const error = await outcome as PairingScanError;
    expect(error).toBeInstanceOf(PairingScanError);
    expect(error.message).toBe(t("scan.noWindow"));
    expect(engine.calls.create).toBe(0);
    expect(dialog()).toBeNull();
  } finally { show.mockRestore(); }
});

test("camera construction failure removes the dialog and preserves its original rejection", async () => {
  const failure = new Error("worker unavailable");
  let outcome!: Promise<unknown>;
  await act(async () => {
    outcome = openPairingScanner(origin, () => { throw failure; }).catch(error => error);
  });
  expect(await outcome).toBe(failure);
  expect(dialog()).toBeNull();
});

test("the public scan entry rejects unavailable camera access before mounting", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  try {
    await expect(scanPairingCode(origin)).rejects.toThrow(t("scan.noCamera"));
    expect(dialog()).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "mediaDevices", descriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  }
});
