/** Canonical daemon downloads and the old install/update URLs share one asset set. */
const FILES = new Set([
  "VERSION", "SHA256SUMS", "release.json",
  "pairfob-darwin-amd64", "pairfob-darwin-arm64",
  "pairfob-linux-amd64", "pairfob-linux-arm64",
  // install.sh installs pairfob-chat beside the daemon when SHA256SUMS lists
  // it, and the daemon manifest lists it, so the guard has to let it through.
  "pairfob-chat-darwin-amd64", "pairfob-chat-darwin-arm64",
  "pairfob-chat-linux-amd64", "pairfob-chat-linux-arm64",
]);
const ORIGINS = new Set(["https://pairfob.com", "https://localhost"]);

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
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
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
