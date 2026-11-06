/** Canonical daemon downloads and the old install/update URLs share one asset set. */
const FILES = new Set([
  "VERSION", "SHA256SUMS", "release.json", "release.json.sig",
  "pairfob-darwin-amd64", "pairfob-darwin-arm64",
  "pairfob-linux-amd64", "pairfob-linux-arm64",
  // install.sh installs pairfob-chat beside the daemon when SHA256SUMS lists
  // it, and the daemon manifest lists it, so the guard has to let it through.
  "pairfob-chat-darwin-amd64", "pairfob-chat-darwin-arm64",
  "pairfob-chat-linux-amd64", "pairfob-chat-linux-arm64",
]);
// The Android shell loads from https://localhost and the iOS shell from
// capacitor://localhost; both fetch /dl/VERSION cross-origin with
// cache: "no-store", so the preflight below must also allow the cache headers.
const ORIGINS = new Set(["https://pairfob.com", "https://localhost", "capacitor://localhost"]);

export async function daemonDownload(
  req: Request,
  assets: { fetch(req: Request): Promise<Response> },
): Promise<Response | null> {
  const url = new URL(req.url);
  const prefix = url.pathname.startsWith("/daemon/") ? "/daemon/"
    : url.pathname.startsWith("/dl/") ? "/dl/" : null;
  const installer = url.pathname === "/install.sh";
  if (!prefix && !installer) return null;
  const name = prefix ? url.pathname.slice(prefix.length) : "install.sh";
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" });
  const origin = req.headers.get("Origin");
  if (origin && ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  if (!installer && !FILES.has(name)) return new Response(null, { status: 404, headers });
  if (req.method === "OPTIONS") {
    if (origin && ORIGINS.has(origin)) {
      headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      // `cache: "no-store"` makes the browser send Cache-Control and Pragma,
      // which are not CORS-safelisted headers; reflect only those we use.
      const requested = (req.headers.get("Access-Control-Request-Headers") || "")
        .toLowerCase()
        .split(",")
        .map((header) => header.trim())
        .filter((header) => header === "cache-control" || header === "pragma");
      headers.set("Access-Control-Allow-Headers", requested.length ? requested.join(", ") : "content-type");
      headers.set("Access-Control-Max-Age", "600");
      // The reflected allow-list varies with the request, not only the origin.
      headers.set("Vary", "Origin, Access-Control-Request-Headers");
    }
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD, OPTIONS");
    return new Response(null, { status: 405, headers });
  }
  // A direct asset read preserves old clients that do not follow redirects.
  const target = new URL(installer ? "/install.sh" : `/daemon/${name}`, "https://dl.pairfob.com");
  const response = await assets.fetch(new Request(target, { method: req.method, headers: req.headers }));
  const merged = new Headers(response.headers);
  headers.forEach((value, key) => merged.set(key, value));
  merged.set("Content-Type", name.startsWith("pairfob-") ? "application/octet-stream"
    : name === "release.json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
  return new Response(req.method === "HEAD" ? null : response.body, { status: response.status, headers: merged });
}
