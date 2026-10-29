import { afterEach, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import { canOpenOnDevice, isShareCancel, openOnDevice, shareCandidate } from "./download-share";

/** Navigator capabilities are replaced per case and put back after it. */
const originals = new Map<string, PropertyDescriptor | undefined>();

function stub(properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(navigator, key));
    Object.defineProperty(navigator, key, { configurable: true, writable: true, value });
  }
}

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(navigator, key, descriptor);
    else Reflect.deleteProperty(navigator, key);
  }
  originals.clear();
});

const file = () => new File([new Uint8Array([1, 2, 3])], "app.zip", { type: "application/zip" });

test("sharing files needs both calls, not just one of them", () => {
  expect(shareCandidate()).toBe(false);
  stub({ share: async () => undefined });
  expect(shareCandidate()).toBe(false);
  stub({ canShare: () => true });
  expect(shareCandidate()).toBe(true);
});

test("canOpenOnDevice asks about that exact file", () => {
  const asked: File[] = [];
  stub({ share: async () => undefined, canShare: (data: { files?: File[] }) => {
    asked.push(...(data.files ?? []));
    return true;
  } });
  const target = file();
  expect(canOpenOnDevice(target)).toBe(true);
  expect(asked[0]).toBe(target);

  stub({ canShare: () => false });
  expect(canOpenOnDevice(target)).toBe(false);
  // A browser that throws on the question cannot take the file either.
  stub({ canShare: () => { throw new TypeError("files not supported"); } });
  expect(canOpenOnDevice(target)).toBe(false);
  stub({ canShare: undefined });
  expect(canOpenOnDevice(target)).toBe(false);
});

test("openOnDevice hands over the file and its name", async () => {
  let shared: { files?: File[]; title?: string } | undefined;
  const target = file();
  stub({ share: async (data: { files?: File[]; title?: string }) => { shared = data; }, canShare: () => true });
  await openOnDevice(target);
  expect(shared?.files?.[0]).toBe(target);
  expect(shared?.title).toBe("app.zip");
});

test("a browser without the share call rejects instead of silently doing nothing", async () => {
  await expect(openOnDevice(file())).rejects.toThrow("share is unavailable");
});

test("a dismissed share sheet is not a failure", () => {
  expect(isShareCancel(new DOMException("cancelled", "AbortError"))).toBe(true);
  expect(isShareCancel(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
  expect(isShareCancel(new Error("share failed"))).toBe(false);
  expect(isShareCancel(null)).toBe(false);
});
