const CACHE = "pairfob-shell-v7";
const SHELL = ["/", "/pair", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const SHELL_NETWORK_GRACE_MS = 750;

function shellAssetPaths(html) {
  return [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"'?#]+)["']/g)].map((match) => match[1]);
}

async function precacheShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  const assets = new Set();
  for (const path of ["/", "/pair"]) {
    const response = await cache.match(path);
    if (!response) continue;
    const html = await response.text();
    for (const asset of shellAssetPaths(html)) assets.add(asset);
  }
  if (assets.size) await cache.addAll([...assets]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
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
  const assets = shellAssetPaths(await response.clone().text());
  if (assets.length) await cache.addAll(assets);
  await cache.put(request, response.clone());
  return response;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return cacheSuccessful(request, await fetch(request));
}

async function shellNetworkFirst(event, request, fallback) {
  const cached = await caches.match(request) || await caches.match(fallback);
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v2/")) return;
  // Homepage Docs links to /doc/. Falling back to the cached marketing shell
  // makes that click look like it never left the landing page.
  if (url.pathname === "/doc" || url.pathname.startsWith("/doc/")) return;
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

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || "Agent 需要你处理" }; }
  const title = typeof data.title === "string" ? data.title : "Pairfob";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "Agent 状态已更新",
    tag: typeof data.tag === "string" ? data.tag : "herd",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: safeNotificationURL(data.url) },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safeNotificationURL(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) await client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
