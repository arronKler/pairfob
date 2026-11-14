/** Serve two browser benchmark modules without changing the checkout.
 * bun scripts/connection-benchmark.ts <baseline-commit>
 * In a browser import /baseline.js and /current.js; alternate connectionSample
 * calls and compare cryptoSample(false/true).
 */
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const ref = process.argv[2];
if (!ref) throw new Error("usage: bun scripts/connection-benchmark.ts <baseline-commit>");
const baseline = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const entry = resolve(import.meta.dir, "connection-benchmark-fixture.ts");
// Only these production modules changed. All fixture, transport, dependency and
// bundler inputs are identical; baseline bodies come from the requested commit.
const originals = new Map<string, string>();
for (const name of ["relay-dial", "session-handshake"]) {
  const path = resolve(root, `pwa/src/lib/protocol/${name}.ts`);
  originals.set(path, execFileSync("git", ["show", `${baseline}:${relative(root, path)}`], { cwd: root, encoding: "utf8" }));
}
async function bundle(old: boolean) {
  const result = await Bun.build({
    entrypoints: [entry], target: "browser", format: "esm", minify: true,
    plugins: old ? [{ name: "baseline-handshake", setup(build) {
      build.onLoad({ filter: /\/(relay-dial|session-handshake)\.ts$/ }, ({ path }) => {
        const contents = originals.get(path);
        return contents === undefined ? undefined : { contents, loader: "ts" };
      });
    } }] : [],
  });
  if (!result.success) throw new AggregateError(result.logs, "benchmark build failed");
  return result.outputs[0]!;
}
const current = await bundle(false), previous = await bundle(true);
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const headers = { "Cache-Control": "no-store", "Content-Type": "text/javascript" };
    if (path === "/current.js") return new Response(current, { headers });
    if (path === "/baseline.js") return new Response(previous, { headers });
    if (path === "/") return new Response("<!doctype html><title>Pairfob connection benchmark</title><p>Local authenticated connection fixture. No production traffic.</p>", { headers: { "Content-Type": "text/html" } });
    return new Response("not found", { status: 404 });
  },
});
console.log(JSON.stringify({ url: server.url.href, baseline, currentBytes: current.size, baselineBytes: previous.size }));
