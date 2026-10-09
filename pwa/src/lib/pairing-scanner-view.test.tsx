import { expectSameNode } from "../../test-support/node-identity";
import { happy, resetTestDOM } from "../../test-support/boot-dom";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { openPairingScanner, PairingScanError, type ScannerFactory, type ScanResult } from "./pairing-scanner-view";
import { scanPairingCode } from "./pairing-scanner";
import { parsePairingURL, type FragmentPairing } from "./pairing-input";
import { setLang, t } from "./i18n";
import { bindOverlayOrigin } from "../shared/ui/overlay";

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
  let result!: Promise<ScanResult>;
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
  expect(modal.classList.contains("sheet")).toBeTrue();
  expect(modal.querySelector("#scanner-title")?.textContent).toBe(t("scan.title"));
  expect(modal.querySelectorAll(".scanner-corner")).toHaveLength(4);
  expect(modal.querySelector(".scanner-to-code")?.textContent).toBe(t("scan.toCode"));
  expect(video.hasAttribute("playsinline")).toBeTrue();
  expect(video.muted).toBeTrue();
  await act(async () => engine.decode(qr.replace(origin, "https://example.com")));
  expect(modal.querySelector("[role=alert]")?.textContent).toBe(t("scan.wrongSite"));
  expectSameNode(engine.video(), modal.querySelector("video"));
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
  expectSameNode(document.activeElement, trigger);
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
] as const)("camera failure %s stays in the sheet with its reason and a way to type the code", async (name, key) => {
  const permission = deferred();
  const engine = camera(permission.promise);
  const outcome = open(engine.factory);
  await act(async () => permission.reject(Object.assign(new Error("camera"), { name })));
  expect(engine.calls.destroy).toBe(1);
  expect(dialog().open).toBeTrue();
  expect(dialog().querySelector("video")).toBeNull();
  expect(dialog().querySelector(".scanner-blocked-copy")?.textContent).toBe(t(key));
  await act(async () => dialog().querySelector<HTMLButtonElement>(".scanner-to-code")!.click());
  expect(await outcome).toBe("code");
  expect(dialog()).toBeNull();
});

test("typing the code instead retires the camera and resolves to the code sheet", async () => {
  const engine = camera();
  const result = open(engine.factory);
  await act(async () => dialog().querySelector<HTMLButtonElement>(".scanner-to-code")!.click());
  expect(await result).toBe("code");
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

test("the public scan entry explains unavailable camera access without starting one", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  try {
    let result!: Promise<unknown>;
    await act(async () => { result = scanPairingCode(origin); });
    expect(dialog().querySelector("video")).toBeNull();
    expect(dialog().querySelector(".scanner-blocked-copy")?.textContent).toBe(t("scan.noCamera"));
    await act(async () => dialog().querySelector<HTMLButtonElement>(".sheet-close")!.click());
    expect(await result).toBeNull();
    expect(dialog()).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "mediaDevices", descriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

test("the scanner follows the gesture: the card for a key beside the list, the sheet for a finger", async () => {
  const release = bindOverlayOrigin(document);
  try {
    happy.happyDOM.setWindowSize({ width: 820, height: 1180 });
    document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    let result = open(camera().factory);
    await act(async () => { await Promise.resolve(); });
    expect(dialog().className).toBe("modal sheet scanner-modal desk-form");
    expect(document.body.classList.contains("sheet-open")).toBeFalse();
    // The card closes from its corner, as every desk dialog does; the sheet from its head.
    expect(dialog().querySelector(".sheet-close")).toBeNull();
    await act(async () => dialog().querySelector<HTMLButtonElement>(".desk-close")!.click());
    expect(await result).toBeNull();
    document.body.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }) as unknown as Event);
    result = open(camera().factory);
    await act(async () => { await Promise.resolve(); });
    expect(dialog().className).toBe("modal sheet scanner-modal");
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    await act(async () => dialog().querySelector<HTMLButtonElement>(".sheet-close")!.click());
    expect(await result).toBeNull();
  } finally {
    release();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
});
