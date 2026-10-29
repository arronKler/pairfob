import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { setLang } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import type { LiveSession } from "../../lib/protocol/client";
import type { ActionSheetController } from "../../shared/ui/overlay/action-sheet";
import { SHARE_MAX_BYTES } from "./download-share";
import { DownloadPanel } from "./download-sheet";

const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const handle = "dl_" + "a".repeat(32);
const opened = {
  handle, path: "dist/app.zip", kind: "download" as const, mime: "application/zip",
  size: 1024, modified_ms: 1, revision: "b".repeat(64), expires_ms: 2,
  chunk_bytes: 65_536, max_bytes: 1_073_741_824,
};
let root: Root | null = null;
let host: HTMLElement | null = null;
/** Navigator properties a case replaced, put back after it. */
const navigatorOriginals = new Map<string, PropertyDescriptor | undefined>();
let pickerOriginal: PropertyDescriptor | undefined;

function fakeModal(): ActionSheetController {
  return {
    dismiss: () => undefined,
    close: () => undefined,
  } as unknown as ActionSheetController;
}

function render(session: LiveSession): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<DownloadPanel session={session} paneId="p1" path="dist/app.zip" fallbackSize={1024} modal={fakeModal()} />));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`missing ${label}`);
  return found as HTMLButtonElement;
}

/** Take the File System Access path, so a download finishes without a worker. */
function installPicker(): void {
  pickerOriginal ??= Object.getOwnPropertyDescriptor(window, "showSaveFilePicker");
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, writable: true, value: async () => ({
    createWritable: async () => ({
      write: async () => undefined,
      close: async () => undefined,
      abort: async () => undefined,
    }),
  }) });
}

function stubNavigator(properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (!navigatorOriginals.has(key)) navigatorOriginals.set(key, Object.getOwnPropertyDescriptor(navigator, key));
    Object.defineProperty(navigator, key, { configurable: true, writable: true, value });
  }
}

/** One chunk per RPC, each carrying a byte that names which chunk it is. */
function chunkedSession(total = 1024, chunk = 512): LiveSession {
  return {
    workspaceDownloadOpen: async () => ({ ...opened, size: total }),
    workspaceDownloadRead: async (_handle: string, offset: number) => {
      const length = Math.min(chunk, total - offset);
      const bytes = new Uint8Array(length).fill(offset === 0 ? 1 : 2);
      return { handle, offset, length, bytes, eof: offset + length >= total };
    },
    workspaceDownloadClose: async () => ({ handle, closed: true as const }),
  } as unknown as LiveSession;
}

async function openSheet(): Promise<void> {
  await act(async () => { await pause(); });
}

async function download(): Promise<void> {
  await openSheet();
  await act(async () => { button("选择保存位置").click(); });
  for (let tick = 0; tick < 8; tick += 1) await act(async () => { await pause(); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const [key, descriptor] of navigatorOriginals) {
    if (descriptor) Object.defineProperty(navigator, key, descriptor);
    else Reflect.deleteProperty(navigator, key);
  }
  navigatorOriginals.clear();
  if (pickerOriginal) Object.defineProperty(window, "showSaveFilePicker", pickerOriginal);
  else Reflect.deleteProperty(window, "showSaveFilePicker");
  pickerOriginal = undefined;
});

test("shows the opened file and a save action", async () => {
  const session = {
    workspaceDownloadOpen: async () => opened,
    workspaceDownloadRead: async () => ({ handle, offset: 0, length: 0, bytes: new Uint8Array(), eof: true }),
    workspaceDownloadClose: async () => ({ handle, closed: true as const }),
  } as unknown as LiveSession;
  render(session);
  await act(async () => { await pause(); });
  expect(document.body.textContent).toContain("app.zip");
  expect(document.body.textContent).toContain("1.0 KiB");
  expect(document.body.textContent).toContain("下载");
  expect(document.body.textContent).toContain("只使用 P2P 直连");
});

test("a relay rejection is shown as the P2P requirement", async () => {
  const session = {
    workspaceDownloadOpen: async () => { throw new ProtocolError("p2p_required"); },
    workspaceDownloadRead: async () => { throw new Error("unreachable"); },
    workspaceDownloadClose: async () => ({ handle, closed: true as const }),
  } as unknown as LiveSession;
  render(session);
  await act(async () => { await pause(); });
  expect(document.body.textContent).toContain("文件下载需要 P2P 直连");
  expect(document.body.textContent).toContain("重试");
});

test("closing the sheet releases the daemon handle", async () => {
  let closed = 0;
  const session = {
    workspaceDownloadOpen: async () => opened,
    workspaceDownloadRead: async () => ({ handle, offset: 0, length: 0, bytes: new Uint8Array(), eof: true }),
    workspaceDownloadClose: async () => { closed += 1; return { handle, closed: true as const }; },
  } as unknown as LiveSession;
  render(session);
  await act(async () => { await pause(); });
  await act(async () => {
    root?.unmount();
    root = null;
    await pause();
  });
  expect(closed).toBe(1);
});

test("a finished download offers the file to the system share sheet", async () => {
  installPicker();
  let shared: { files?: File[]; title?: string } | undefined;
  stubNavigator({
    share: async (data: { files?: File[]; title?: string }) => { shared = data; },
    canShare: (data: { files?: File[] }) => (data.files ?? []).length === 1,
  });
  render(chunkedSession());
  await download();

  expect(document.body.textContent).toContain("已保存到你的设备");
  const open = button("打开或分享");
  // The system sheet is the only way to the file; closing stays beside it.
  expect(open.className).toContain("btn-primary");
  expect(button("关闭").className).not.toContain("btn-primary");

  await act(async () => { open.click(); await pause(); });
  const file = shared?.files?.[0];
  expect(shared?.title).toBe("app.zip");
  expect(file?.name).toBe("app.zip");
  expect(file?.size).toBe(1024);
  expect(file?.type).toBe("application/zip");
  const bytes = new Uint8Array(await file!.arrayBuffer());
  expect([bytes[0], bytes[511], bytes[512], bytes[1023]]).toEqual([1, 1, 2, 2]);
});

test("a browser that cannot take the file keeps the closing action alone", async () => {
  installPicker();
  let shared = 0;
  stubNavigator({
    share: async () => { shared += 1; },
    canShare: () => false,
  });
  render(chunkedSession());
  await download();

  expect(document.body.textContent).toContain("已保存到你的设备");
  expect(document.body.textContent).not.toContain("打开或分享");
  expect(button("关闭").className).toContain("btn-primary");
  expect(shared).toBe(0);
});

test("a dismissed share sheet leaves the saved file as it was", async () => {
  installPicker();
  stubNavigator({
    share: async () => { throw new DOMException("cancelled", "AbortError"); },
    canShare: () => true,
  });
  render(chunkedSession());
  await download();

  await act(async () => { button("打开或分享").click(); await pause(); });
  expect(document.body.textContent).toContain("已保存到你的设备");
  expect(document.body.textContent).not.toContain("无法打开分享面板");
});

test("a failed share is reported without pretending the file was lost", async () => {
  installPicker();
  let attempts = 0;
  stubNavigator({
    share: async () => { attempts += 1; throw new Error("share target refused"); },
    canShare: () => true,
  });
  render(chunkedSession());
  await download();

  await act(async () => { button("打开或分享").click(); await pause(); });
  expect(document.body.textContent).toContain("无法打开分享面板");
  expect(document.body.textContent).toContain("已保存到你的设备");

  // The saved file is still there to try again.
  await act(async () => { button("打开或分享").click(); await pause(); });
  expect(attempts).toBe(2);
});

test("a second tap while the sheet is opening does not call it twice", async () => {
  installPicker();
  let calls = 0;
  let finish: (() => void) | undefined;
  stubNavigator({
    share: () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve; }); },
    canShare: () => true,
  });
  render(chunkedSession());
  await download();

  const open = button("打开或分享");
  await act(async () => { open.click(); open.click(); await pause(); });
  expect(calls).toBe(1);
  await act(async () => { finish?.(); await pause(); });
  // The sheet is closed again once it resolves, so the next tap is a fresh one.
  await act(async () => { open.click(); await pause(); });
  expect(calls).toBe(2);
});

test("a file above the share limit is not held in memory", async () => {
  installPicker();
  let shared = 0;
  stubNavigator({
    share: async () => { shared += 1; },
    canShare: () => true,
  });
  const total = SHARE_MAX_BYTES + 1;
  render(chunkedSession(total, total));
  await download();

  expect(document.body.textContent).toContain("已保存到你的设备");
  expect(document.body.textContent).not.toContain("打开或分享");
  expect(shared).toBe(0);
});
