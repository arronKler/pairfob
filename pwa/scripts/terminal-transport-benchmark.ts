import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Compile the actual pre-optimization codecs, not an approximation of them.
// Both bundles use the same receive workload, encryption and message checks.
const baseline = "4a380369adf3b3500106ed95f9e6dcd831a2b3f7";
const pwa = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "pairfob-terminal-transport-"));
const originals = new Map<string, string>();
for (const file of ["bytes.ts", "terminal.ts"]) {
  const source = `pwa/src/lib/protocol/${file}`;
  const git = Bun.spawn(["git", "show", `${baseline}:${source}`], { cwd: pwa, stdout: "pipe", stderr: "pipe" });
  const contents = await new Response(git.stdout).text();
  if (await git.exited !== 0) throw new Error(`baseline ${baseline} is unavailable: ${await new Response(git.stderr).text()}`);
  originals.set(resolve(pwa, "src/lib/protocol", file), contents);
}

try {
  for (const variant of ["baseline", "optimized"]) {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "terminal-transport-workload.ts")],
      target: "browser",
      outdir: temporary,
      naming: `${variant}.js`,
      plugins: variant === "baseline" ? [{
        name: "baseline-codecs",
        setup(build) {
          build.onLoad({ filter: /\/(bytes|terminal)\.ts$/ }, (args) => {
            const contents = originals.get(args.path);
            return contents === undefined ? undefined : { contents, loader: "ts" };
          });
        },
      }] : [],
    });
    if (!result.success) throw new Error(result.logs.join("\n"));
  }

  if (process.argv.includes("--serve")) {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/baseline.js" || path === "/optimized.js") return new Response(Bun.file(join(temporary, path.slice(1))));
        if (path !== "/") return new Response("not found", { status: 404 });
        return new Response(`<!doctype html><meta charset="utf-8"><title>Terminal transport benchmark</title>
<pre id="result">Run window.terminalBenchmark(size) for paired measurements.</pre>
<script type="module">
import * as baseline from "/baseline.js";
import * as optimized from "/optimized.js";
window.terminalBenchmark = (size) => {
  const result = { baseline: baseline.run(size), optimized: optimized.run(size), userAgent: navigator.userAgent };
  document.getElementById("result").textContent = JSON.stringify(result, null, 2);
  return result;
};
</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    console.log(`Terminal benchmark: ${server.url}`);
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    server.stop(true);
  } else {
    const before = await import(join(temporary, "baseline.js"));
    const after = await import(join(temporary, "optimized.js"));
    const results = [64, 4096, 96 * 1024, 4 * 1024 * 1024].map((size) => ({ baseline: before.run(size), optimized: after.run(size) }));
    console.log(JSON.stringify({ benchmark: "terminal-transport-cpu", baseline, runtime: `Bun ${Bun.version}`, results }, null, 2));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
