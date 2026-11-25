const CACHE = "pairfob-shell-v13";
const PREVIOUS_CACHE = "pairfob-shell-v12";
const PREF = "pairfob-pref";
const NOTIFY_DIAGNOSTICS = "pairfob-notification-diagnostics-v1";
const NOTIFY_LOG = "/__pairfob_notification_diagnostics__";
const NOTIFY_RESOLVED = "pairfob-notification-resolved-v1";
const SHELL = ["/", "/pair", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const SHELL_NETWORK_GRACE_MS = 750;

// Content-free evidence survives a worker restart and is exported by Settings.
// Storage work never gates focus/navigation, whose user activation is short-lived.
let diagnosticWrite = Promise.resolve();
function recordNotificationDiagnostic(event, details = {}) {
  const record = { at: Date.now(), event, ...details };
  diagnosticWrite = diagnosticWrite.then(async () => {
    const cache = await caches.open(NOTIFY_DIAGNOSTICS);
    const response = await cache.match(NOTIFY_LOG);
    let previous = [];
    try { previous = response ? await response.json() : []; } catch { /* Replace corrupt evidence. */ }
    const recent = Array.isArray(previous) ? previous.filter(row =>
      row && Number.isFinite(row.at) && row.at >= record.at - 86400000 && row.at <= record.at + 60000) : [];
    await cache.put(NOTIFY_LOG, Response.json([...recent.slice(-99), record]));
  }).catch(() => { /* Diagnostics must never break notification delivery. */ });
  return diagnosticWrite;
}

function detectLang() {
  const nav = self.navigator;
  const list = nav && nav.languages && nav.languages.length ? nav.languages : [nav?.language || ""];
  for (const item of list) {
    const tag = String(item || "").toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

async function readLang() {
  try {
    const cached = await caches.open(PREF).then((cache) => cache.match("lang"));
    const value = cached ? await cached.text() : "";
    if (value === "en" || value === "zh") return value;
  } catch {
    /* private mode */
  }
  return detectLang();
}

function notificationCopy(data, lang) {
  const kind = typeof data.kind === "string" ? data.kind : "";
  const title = typeof data.title === "string" ? data.title : "";
  const blocked = kind === "needs_you" || title.includes("等待确认") || /waiting for you/i.test(title);
  const done = kind === "done" || title.includes("任务已完成") || title.includes("本轮结束") || /task complete|turn finished/i.test(title);
  const en = lang === "en";
  const copy = {
    blocked: en ? "Pairfob · Waiting for you" : "Pairfob · 等待确认",
    done: en ? "Pairfob · Turn finished" : "Pairfob · 本轮结束",
    body: en ? "Agent status updated" : "Agent 状态已更新",
    need: en ? "An agent needs you" : "Agent 需要你处理",
  };
  if (kind === "retract") return {
    title: en ? "Pairfob · No longer waiting" : "Pairfob · 不再等待",
    body: en ? "Open the session to see its current state." : "打开会话查看当前状态。",
  };
  return {
    title: blocked ? copy.blocked : done ? copy.done : title || "Pairfob",
    body: typeof data.body === "string" && data.body ? data.body : blocked ? copy.need : copy.body,
  };
}

function shellAssetPaths(html) {
  return [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"'?#]+)["']/g)].map((match) => match[1]);
}

// Hashed dependency graphs belong to the HTML that named them. Download only
// its startup closure; visiting a deferred feature caches that feature's closure.
const chunkDependencies = new Map();
let graphRead;
const assetPath = value => typeof value === "string" && /^\/assets\/[A-Za-z0-9_.-]+$/.test(value);
function readAssetGraph(graph) {
  if (graph?.schema !== 1 || !Array.isArray(graph.startup) || !graph.startup.every(assetPath)
    || !graph.chunks || typeof graph.chunks !== "object" || Array.isArray(graph.chunks)) throw new Error("Invalid asset graph");
  for (const [file, dependencies] of Object.entries(graph.chunks)) {
    if (!assetPath(file) || !Array.isArray(dependencies) || !dependencies.every(assetPath)
      || !dependencies.includes(file)) throw new Error("Invalid chunk dependencies");
  }
  for (const [file, dependencies] of Object.entries(graph.chunks)) chunkDependencies.set(file, dependencies);
  return graph.startup;
}
function graphPath(html) {
  return html.match(/<meta name="pairfob-assets" content="(\/assets\/pwa-assets-[0-9a-f]{16}\.json)"\s*\/>/)?.[1];
}
async function restoreAssetGraphs() {
  if (!graphRead) graphRead = (async () => {
    const cache = await caches.open(CACHE);
    for (const request of await cache.keys()) {
      if (!/\/assets\/pwa-assets-[0-9a-f]{16}\.json$/.test(request.url)) continue;
      try { readAssetGraph(await (await cache.match(request)).json()); } catch { /* A corrupt graph cannot authorize dependencies. */ }
    }
  })();
  await graphRead;
}
async function precacheShell() {
  for (const path of SHELL) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Shell unavailable");
    if (path === "/" || path === "/pair") await cacheShellResponse(path, response);
    else await cacheSuccessful(path, response);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("pairfob-shell-") && key !== CACHE && key !== PREVIOUS_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => recordNotificationDiagnostic("notify_sw_active")),
  );
});

async function cacheSuccessful(request, response) {
  if (response.ok && response.type === "basic") {
    await caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
  }
  return response;
}

async function cacheShellResponse(request, response) {
  if (!response.ok || response.type !== "basic") return response;
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  const assets = new Set(shellAssetPaths(html));
  const graphURL = graphPath(html);
  if (graphURL) {
    const graphResponse = await caches.match(graphURL) || await fetch(graphURL);
    if (!graphResponse.ok || graphResponse.type !== "basic") throw new Error("Asset graph unavailable");
    for (const file of readAssetGraph(await graphResponse.clone().json())) assets.add(file);
    await cache.put(graphURL, graphResponse);
  }
  // Publish HTML only once all files required to start THAT build are available.
  await Promise.all([...assets].map(cacheAsset));
  await cache.put(request, response.clone());
  return response;
}

const assetReads = new Map();
async function cacheAsset(request) {
  const key = new URL(typeof request === "string" ? request : request.url, self.location.origin).href;
  const cache = await caches.open(CACHE);
  const current = await cache.match(request);
  if (current) return current;
  const previous = await caches.match(request);
  if (previous) {
    // Own reused bytes before the older generation can be removed on upgrade.
    await cache.put(request, previous.clone());
    return previous;
  }
  let pending = assetReads.get(key);
  if (!pending) {
    pending = fetch(request).then(response => {
      if (!response.ok || response.type !== "basic") throw new Error("Asset unavailable");
      return cacheSuccessful(request, response);
    }).finally(() => assetReads.delete(key));
    assetReads.set(key, pending);
  }
  return (await pending).clone();
}

async function cacheFirst(request) {
  await restoreAssetGraphs();
  const path = new URL(typeof request === "string" ? request : request.url, self.location.origin).pathname;
  // Await static imports and CSS together. No dynamic children are prefetched.
  await Promise.all((chunkDependencies.get(path) || [path]).map(cacheAsset));
  return cacheAsset(request);
}

async function shellNetworkFirst(event, request, fallback) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request) || await cache.match(fallback)
    || await caches.match(request) || await caches.match(fallback);
  // Cache referenced hashed assets before publishing a newer HTML shell, so an
  // offline load never observes a half-updated app version.
  const network = fetch(request).then((response) => cacheShellResponse(request, response));
  if (!cached) return network.catch(() => Response.error());
  let timer;
  const grace = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SHELL_NETWORK_GRACE_MS); });
  const fresh = await Promise.race([network.catch(() => null), grace]);
  clearTimeout(timer);
  if (fresh?.ok) return fresh;
  event.waitUntil(network.catch(() => undefined));
  return cached;
}

const DOWNLOAD_CHANNEL = "pairfob-download-v1";
const DOWNLOAD_ROUTE = "/__pairfob_download__/";
const DOWNLOAD_MAX_BYTES = 1073741824;
const DOWNLOAD_PULL_TIMEOUT_MS = 30000;

function downloadFileName(value) {
  const base = String(value || "download").split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f"\\;]/g, "_").slice(0, 180);
  return base || "download";
}

function downloadDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, value =>
    `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * A download is a page-driven BYTE stream. The service worker cannot read the
 * encrypted Pairfob session itself, so each pull asks the page for one chunk
 * over a BroadcastChannel. The page reads the RPC and posts the chunk back;
 * one outstanding request is the backpressure.
 */
function downloadStreamResponse(url, routeAt = url.pathname.indexOf(DOWNLOAD_ROUTE)) {
  if (routeAt < 0) return new Response("bad download route", { status: 400 });
  const id = url.pathname.slice(routeAt + DOWNLOAD_ROUTE.length);
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response("bad download id", { status: 400 });
  const name = downloadFileName(url.searchParams.get("name"));
  const size = Number(url.searchParams.get("size"));
  if (!Number.isSafeInteger(size) || size < 0 || size > DOWNLOAD_MAX_BYTES) {
    return new Response("bad download size", { status: 400 });
  }
  const rawMime = url.searchParams.get("mime") || "application/octet-stream";
  const mime = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/.test(rawMime)
    ? rawMime : "application/octet-stream";
  const channel = new BroadcastChannel(DOWNLOAD_CHANNEL);
  let streamController;
  let pending = null;
  let finished = false;
  let timer = null;
  const close = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    channel.close();
  };
  const fail = (message) => {
    const error = new Error(message);
    if (pending) {
      const waiting = pending;
      pending = null;
      if (timer) clearTimeout(timer);
      waiting.reject(error);
    }
    // Cancellation can arrive between pulls while a chunk is still queued.
    try { streamController.error(error); } catch { /* already closed */ }
    close();
  };
  channel.onmessage = (event) => {
    const data = event.data;
    if (!data || data.id !== id) return;
    if (data.type === "chunk") {
      if (!pending) return;
      const waiting = pending;
      pending = null;
      if (timer) clearTimeout(timer);
      const bytes = data.bytes instanceof ArrayBuffer ? new Uint8Array(data.bytes) : data.bytes;
      if (!(bytes instanceof Uint8Array)) {
        waiting.reject(new Error("invalid download chunk"));
        try { waiting.controller.error(new Error("invalid download chunk")); } catch { /* already closed */ }
        close();
        return;
      }
      waiting.controller.enqueue(bytes);
      waiting.resolve();
      if (data.eof) {
        try { waiting.controller.close(); } catch { /* already closed */ }
        channel.postMessage({ type: "done", id });
        setTimeout(close, 1000);
      }
      return;
    }
    if (data.type === "error") fail(String(data.message || "download failed"));
    if (data.type === "cancel") fail("download canceled");
  };
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      channel.postMessage({ type: "start", id, size });
    },
    pull(controller) {
      if (finished) return;
      if (pending) return pending.promise;
      let resolve;
      let reject;
      const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
      pending = { controller, resolve, reject, promise };
      timer = setTimeout(() => {
        if (!pending) return;
        pending = null;
        reject(new Error("download source timed out"));
        try { controller.error(new Error("download source timed out")); } catch { /* already closed */ }
        close();
      }, DOWNLOAD_PULL_TIMEOUT_MS);
      channel.postMessage({ type: "need", id });
      return promise;
    },
    cancel() {
      channel.postMessage({ type: "cancel", id });
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": downloadDisposition(name),
      "Content-Length": String(size),
      "Cache-Control": "no-store",
    },
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const downloadAt = url.pathname.indexOf(DOWNLOAD_ROUTE);
  if (downloadAt >= 0) {
    event.respondWith(downloadStreamResponse(url, downloadAt));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v2/")) return;
  // Runner owns a distinct sandbox/CSP; never substitute a cached app shell.
  if (url.pathname.startsWith("/preview/")) return;
  // Homepage Docs links to /doc/. Falling back to the cached marketing shell
  // makes that click look like it never left the landing page.
  if (url.pathname === "/doc" || url.pathname.startsWith("/doc/")) return;
  // Release checks must report network failure instead of a cached release.
  if (url.pathname === "/dl/VERSION") return;
  if (request.mode === "navigate") {
    const fallback = url.pathname.startsWith("/pair") ? "/pair" : "/";
    event.respondWith(shellNetworkFirst(event, request, fallback));
    return;
  }
  if (url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(request).catch(() => Response.error()));
    return;
  }
  event.respondWith(fetch(request).then((response) => cacheSuccessful(request, response)).catch(() => caches.match(request).then((hit) => hit || Response.error())));
});

function safeNotificationURL(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/pair", self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== "/pair" || url.search) return "/pair";
    if (!url.hash) return "/pair";
    const params = new URLSearchParams(url.hash.slice(1));
    const keys = [...params.keys()];
    const exactKeys = keys.length === 3 && new Set(keys).size === 3 && keys.every((key) => ["notify", "d", "pane"].includes(key));
    const validDaemon = /^d_[0-9a-f]{20}$/.test(params.get("d") || "");
    const validPane = /^[A-Za-z0-9._:-]{1,256}$/.test(params.get("pane") || "");
    return exactKeys && params.get("notify") === "1" && validDaemon && validPane ? url.pathname + url.hash : "/pair";
  } catch {
    return "/pair";
  }
}

self.addEventListener("message", (event) => {
  const lang = event.data && event.data.lang;
  if (!event.data || event.data.type !== "pairfob_lang") return;
  if (lang !== "en" && lang !== "zh" && lang !== "auto") return;
  event.waitUntil(caches.open(PREF).then((cache) => cache.put("lang", new Response(lang === "auto" ? "" : lang))));
});

// Retain content-free resolution markers across worker restarts. A delayed
// needs-you push must not restore an episode whose resolution arrived first.
const resolvedEpisodes = new Map();
async function notificationResolutions(tag, episode, resolve) {
  const key = "/__pairfob_notification_resolved__/" + encodeURIComponent(tag);
  let rows = resolvedEpisodes.get(tag);
  let cache;
  try {
    cache = await caches.open(NOTIFY_RESOLVED);
    if (!rows) rows = await (await cache.match(key))?.json();
  } catch { /* Keep ordering protection in memory when storage is unavailable. */ }
  const now = Date.now();
  rows = Array.isArray(rows) ? rows.filter(row => row && typeof row.event === "string"
    && Number.isFinite(row.at) && row.at >= now - 86400000 && row.at <= now + 60000) : [];
  const retired = rows.some(row => row.event === episode);
  if (resolve && !retired) rows.push({ event: episode, at: now });
  rows = rows.slice(-32);
  resolvedEpisodes.delete(tag);
  resolvedEpisodes.set(tag, rows);
  if (resolvedEpisodes.size > 256) resolvedEpisodes.delete(resolvedEpisodes.keys().next().value);
  if (resolve && cache) try {
    await cache.put(key, Response.json(rows));
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - 256)).map(old => cache.delete(old)));
  } catch { /* Display must not depend on storage writes. */ }
  return retired;
}

async function showPushNotification(data) {
  const tag = typeof data.tag === "string" && data.tag ? data.tag : "herd";
  const episode = typeof data.event === "string" ? data.event : "";
  const resolving = data.kind === "retract";
  const retired = episode && (resolving || data.kind === "needs_you")
    ? await notificationResolutions(tag, episode, resolving) : false;
  const quiet = resolving || retired;
  let current;
  if (quiet) {
    // Re-show a newer episode (or completion) instead of replacing it with an
    // older resolution. Every push must display a notice: Safari revokes
    // subscriptions that perform silent work, including close-only pushes.
    try {
      const shown = await self.registration.getNotifications({ tag });
      current = shown.find(notice => {
        if ((notice.data?.event || "") === episode) return false;
        const incomingAt = data.event_at;
        const currentAt = notice.data?.event_at;
        // Nanoseconds travel as decimal strings to retain all precision.
        // A resolution for a newer episode must replace an older wait too.
        return !/^[0-9]{19}$/.test(incomingAt) || !/^[0-9]{19}$/.test(currentAt)
          || currentAt >= incomingAt;
      });
    } catch { /* Fall back to the visible resolution. */ }
    if (!current) data = { ...data, kind: "retract" };
  }
  const copy = current || notificationCopy(data, await readLang());
  await self.registration.showNotification(copy.title, {
    body: copy.body,
    tag,
    icon: "/icon.svg",
    badge: "/icon.svg",
    renotify: !quiet,
    silent: quiet ? true : undefined,
    data: current ? current.data : {
      url: safeNotificationURL(data.url), event: episode, event_at: data.event_at, kind: data.kind,
    },
  });
  await recordNotificationDiagnostic(resolving ? "notify_sw_retract" : "notify_sw_shown",
    quiet ? { reason: current ? "preserved" : "resolved" } : {});
}

// Push events may overlap while reading preferences or creating a notice.
// Order display work so a resolution cannot overtake its in-flight notice.
let notificationWork = Promise.resolve();
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || "" }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const pending = notificationWork.then(() => showPushNotification(data));
  notificationWork = pending.catch(() => {});
  event.waitUntil(pending);
});

// Older pages do not speak the message protocol. Only fall back to navigation
// when capture was not acknowledged; a warm current page never needs a reload.
function deliverNotification(client, url, note) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (captured) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(captured);
    };
    const timer = setTimeout(() => { note("notify_sw_ack", { reason: "timeout" }); finish(false); }, 1000);
    channel.port1.onmessage = (event) => {
      if (event.data?.type === "pairfob_notify_captured") {
        note("notify_sw_ack", { reason: "captured" });
        finish(true);
      }
    };
    try {
      client.postMessage({ type: "pairfob_notify", url }, [channel.port2]);
      note("notify_sw_message", { reason: "sent" });
    } catch { note("notify_sw_message", { reason: "error" }); finish(false); }
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safeNotificationURL(event.notification.data?.url), self.location.origin).href;
  const writes = [];
  const deliveries = [];
  const note = (stage, details) => { writes.push(recordNotificationDiagnostic(stage, details)); };
  note("notify_sw_click", { reason: new URL(target).hash ? "ok" : "invalid_target" });
  event.waitUntil((async () => {
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      note("notify_sw_clients", { usable_count: clients.filter(client => {
        const url = new URL(client.url);
        return url.origin === self.location.origin && url.pathname === "/pair" && "focus" in client;
      }).length, stored_count: clients.length });
      for (const client of clients) {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin || url.pathname !== "/pair" || !("focus" in client)) continue;
        note("notify_sw_selected", { hidden: client.visibilityState === "hidden" });
        const delivered = deliverNotification(client, target, note);
        deliveries.push(delivered);
        // Focus immediately, so a suspended app can receive and capture it.
        try {
          note("notify_sw_focus", { reason: "pending" });
          await client.focus();
          note("notify_sw_focus", { reason: "ok" });
          if (await delivered) return;
          if ("navigate" in client) {
            note("notify_sw_navigate", { reason: "pending" });
            const navigated = await client.navigate(target);
            note("notify_sw_navigate", { reason: navigated ? "ok" : "missing" });
            if (navigated) return;
          }
        } catch {
          note("notify_sw_client_error", { reason: "error" });
        }
      }
      note("notify_sw_open", { reason: "pending" });
      const opened = await self.clients.openWindow(target);
      note("notify_sw_open", { reason: opened ? "ok" : "missing" });
    } catch (error) {
      note("notify_sw_error", { reason: "error" });
      throw error;
    }
    finally {
      await Promise.all(deliveries);
      await Promise.all(writes);
    }
  })());
});
