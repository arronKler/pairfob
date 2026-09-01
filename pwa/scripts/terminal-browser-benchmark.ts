import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

type CDPResponse = {
  id?: number;
  result?: unknown;
  error?: { message: string };
};

const MOBILE_PROFILE = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  cpuThrottlingRate: 4,
  latencyMs: 150,
  downloadBytesPerSecond: 200_000,
  uploadBytesPerSecond: 93_750,
};

class CDPClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => void this.handleMessage(event));
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CDPClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("could not connect to Chrome DevTools")), { once: true });
    });
    return new CDPClient(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const text = typeof event.data === "string" ? event.data : await event.data.text();
    const message = JSON.parse(text) as CDPResponse;
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
}

function benchmarkPage(scriptPath: string, stylePath: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="${stylePath}">
<style>
html,body { margin:0; width:100%; height:100%; overflow:hidden; background:#090c10; }
#terminal { width:100%; height:calc(100% - 32px); padding-top:32px; box-sizing:border-box; }
</style>
<div id="terminal"></div>
<script type="module">
globalThis.runTerminalBenchmark = async () => {
  const round = (value) => Math.round(value * 100) / 100;
  const longTasks = [];
  const canObserveLongTasks = PerformanceObserver.supportedEntryTypes?.includes("longtask") === true;
  const observer = canObserveLongTasks
    ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
    : null;
  observer?.observe({ type: "longtask", buffered: true });
  const heapBefore = performance.memory?.usedJSHeapSize ?? null;
  const importStarted = performance.now();
  const module = await import(${JSON.stringify(scriptPath)});
  const importMs = performance.now() - importStarted;
  const warmImportStarted = performance.now();
  const warmModule = await import(${JSON.stringify(scriptPath)});
  const warmImportMs = performance.now() - warmImportStarted;
  if (warmModule !== module) throw new Error("xterm module cache was not reused");
  const terminal = new module.Terminal({
    cols: 80,
    rows: 24,
    scrollback: 0,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1,
    convertEol: false,
  });
  const fit = new module.FitAddon();
  const webgl = new module.WebglAddon();
  let contextLosses = 0;
  webgl.onContextLoss(() => contextLosses++);
  terminal.loadAddon(fit);
  terminal.loadAddon(webgl);
  const openStarted = performance.now();
  const mount = document.querySelector("#terminal");
  terminal.open(mount);
  fit.fit();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const openReadyMs = performance.now() - openStarted;
  const canvases = [...mount.querySelectorAll(".xterm-screen canvas")];
  const domFallback = mount.querySelector(".xterm-rows") !== null;
  const webglCanvasCount = canvases.filter((canvas) => {
    try { return canvas.getContext("webgl2") !== null; } catch { return false; }
  }).length;
  if (domFallback || webglCanvasCount === 0) throw new Error("benchmark did not activate the WebGL2 renderer");

  const row = "\\x1b[32mworker\\x1b[0m 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\\r\\n";
  const frame = row.repeat(48);
  const frameBytes = new TextEncoder().encode(frame).byteLength;
  const frameCount = 256;
  const outputBytes = frameBytes * frameCount;
  const writeStarted = performance.now();
  const writes = [];
  for (let index = 0; index < frameCount; index++) {
    writes.push(new Promise((resolve) => terminal.write(frame, resolve)));
  }
  await Promise.all(writes);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const writeDrainMs = performance.now() - writeStarted;
  const heapAfter = performance.memory?.usedJSHeapSize ?? null;
  observer?.disconnect();
  if (contextLosses > 0) throw new Error("WebGL context was lost " + contextLosses + " time(s)");
  const renderer = {
    kind: "webgl2",
    canvasCount: canvases.length,
    webglCanvasCount,
    domFallback,
    contextLosses,
    canvasBackingBytesEstimate: canvases.reduce((total, canvas) => total + canvas.width * canvas.height * 4, 0),
  };
  terminal.dispose();
  return {
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    importMs: round(importMs),
    warmImportMs: round(warmImportMs),
    openReadyMs: round(openReadyMs),
    outputBytes,
    writeDrainMs: round(writeDrainMs),
    throughputMiBPerSecond: round(outputBytes / 1048576 / (writeDrainMs / 1000)),
    longTasks: {
      supported: canObserveLongTasks,
      count: longTasks.length,
      totalMs: round(longTasks.reduce((total, value) => total + value, 0)),
      maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
    },
    heapDeltaBytes: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
    renderer,
  };
};
</script>`;
}

async function findChrome(): Promise<string> {
  const candidates = [
    process.env.PAIRFOB_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error("Chrome was not found; set PAIRFOB_CHROME to its executable path");
}

async function reserveDebugPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => resolve());
  });
  const address = reservation.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("could not reserve a Chrome DevTools port");
  return port;
}

async function waitForDebugPort(port: number, chrome: Bun.Subprocess): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      /* Chrome is still starting. */
    }
    if (chrome.exitCode !== null) {
      const stderr = chrome.stderr === null ? "" : await new Response(chrome.stderr).text();
      throw new Error(`Chrome exited before exposing DevTools${stderr ? `: ${stderr.trim()}` : ""}`);
    }
    await Bun.sleep(50);
  }
  throw new Error(`Chrome did not expose DevTools on port ${port}`);
}

async function waitForPageTarget(port: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await Bun.sleep(50);
  }
  throw new Error("Chrome did not create a page target");
}

async function evaluate<T>(client: CDPClient, expression: string, awaitPromise = false): Promise<T> {
  const response = await client.send<{
    result: { value?: T; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value as T;
}

const pwaDir = resolve(import.meta.dir, "..");
const distDir = join(pwaDir, "dist");
const assets = await readdir(join(distDir, "assets"));
const scriptName = assets.find((name) => /^full-terminal-xterm-.*\.js$/.test(name));
const styleName = assets.find((name) => /^full-terminal-xterm-.*\.css$/.test(name));
if (!scriptName || !styleName) throw new Error("terminal assets are missing; run bun run build first");
const scriptPath = `/assets/${scriptName}`;
const stylePath = `/assets/${styleName}`;
const page = benchmarkPage(scriptPath, stylePath);
const compressedAssets = new Map<string, { body: Uint8Array; contentType: string; rawBytes: number }>();
for (const [pathname, filename, contentType] of [
  [scriptPath, scriptName, "text/javascript; charset=utf-8"],
  [stylePath, styleName, "text/css; charset=utf-8"],
] as const) {
  const raw = new Uint8Array(await Bun.file(join(distDir, "assets", filename)).arrayBuffer());
  compressedAssets.set(pathname, { body: Bun.gzipSync(raw), contentType, rawBytes: raw.byteLength });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__terminal_benchmark") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    const compressed = compressedAssets.get(pathname);
    if (compressed) {
      return new Response(compressed.body, {
        headers: {
          "cache-control": "no-store",
          "content-encoding": "gzip",
          "content-type": compressed.contentType,
        },
      });
    }
    const filePath = resolve(distDir, `.${decodeURIComponent(pathname)}`);
    if (!filePath.startsWith(`${distDir}${sep}`)) return new Response("not found", { status: 404 });
    const file = Bun.file(filePath);
    if (!await file.exists()) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});

const profileDir = await mkdtemp(join(tmpdir(), "pairfob-terminal-benchmark-"));
const chromePath = await findChrome();
const debugPort = await reserveDebugPort();
const chrome = Bun.spawn([
  chromePath,
  "--headless=new",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--enable-precise-memory-info",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-allow-origins=*",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdout: "ignore", stderr: "pipe" });

let client: CDPClient | null = null;
try {
  await waitForDebugPort(debugPort, chrome);
  client = await CDPClient.connect(await waitForPageTarget(debugPort));
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: MOBILE_PROFILE.latencyMs,
    downloadThroughput: MOBILE_PROFILE.downloadBytesPerSecond,
    uploadThroughput: MOBILE_PROFILE.uploadBytesPerSecond,
  });
  await client.send("Emulation.setCPUThrottlingRate", { rate: MOBILE_PROFILE.cpuThrottlingRate });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: MOBILE_PROFILE.width,
    height: MOBILE_PROFILE.height,
    deviceScaleFactor: MOBILE_PROFILE.deviceScaleFactor,
    mobile: true,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  await client.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/__terminal_benchmark` });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    ready = await evaluate<boolean>(client, "document.readyState === 'complete' && typeof runTerminalBenchmark === 'function'");
    if (ready) break;
    await Bun.sleep(50);
  }
  if (!ready) throw new Error("terminal benchmark page did not become ready");
  const metrics = await evaluate<Record<string, unknown>>(client, "runTerminalBenchmark()", true);
  const scriptAsset = compressedAssets.get(scriptPath)!;
  const styleAsset = compressedAssets.get(stylePath)!;
  console.log(JSON.stringify({
    benchmark: "pairfob-terminal-mobile-webgl-renderer",
    profile: MOBILE_PROFILE,
    assets: {
      scriptRawBytes: scriptAsset.rawBytes,
      scriptTransferBytes: scriptAsset.body.byteLength,
      styleRawBytes: styleAsset.rawBytes,
      styleTransferBytes: styleAsset.body.byteLength,
    },
    metrics,
  }, null, 2));
} finally {
  client?.close();
  chrome.kill();
  await chrome.exited.catch(() => undefined);
  server.stop(true);
  await rm(profileDir, { recursive: true, force: true });
}
