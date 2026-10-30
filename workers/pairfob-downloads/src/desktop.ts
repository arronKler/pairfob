/**
 * The desktop channel: a release manifest and one executable per published
 * platform. Names are stable, so every response is uncached; the publisher
 * verifies the bytes against the manifest before deploying.
 */
const FILES = new Set([
  "release.json",
  "VERSION",
  "SHA256SUMS",
  "pairfob-desktop-darwin-amd64",
  "pairfob-desktop-darwin-arm64",
  "pairfob-desktop-linux-amd64",
  "pairfob-desktop-linux-arm64",
]);
const PREFIX = "/desktop/";

export async function desktopDownload(
  req: Request,
  assets: { fetch(req: Request): Promise<Response> },
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const name = url.pathname.slice(PREFIX.length);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (!FILES.has(name)) return new Response(null, { status: 404, headers });
  if (req.method === "OPTIONS") {
    headers.set("Allow", "GET, HEAD, OPTIONS");
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD, OPTIONS");
    return new Response(null, { status: 405, headers });
  }
  const target = new URL(PREFIX + name, "https://dl.pairfob.com");
  const response = await assets.fetch(
    new Request(target, { method: req.method, headers: req.headers }),
  );
  const merged = new Headers(response.headers);
  headers.forEach((value, key) => merged.set(key, value));
  merged.set("Content-Type", contentType(name));
  return new Response(req.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers: merged,
  });
}

function contentType(name: string): string {
  if (name === "release.json") return "application/json; charset=utf-8";
  if (name === "VERSION" || name === "SHA256SUMS") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}