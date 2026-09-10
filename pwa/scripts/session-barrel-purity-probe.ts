/**
 * Fresh-process import probe for the public session owner/model barrel.
 *
 * Each module is imported in its own Bun process after browser globals are
 * removed. The public entry is the entire `features/session/index.ts` graph,
 * not a source-string check that only dropped `pane-swipe`.
 *
 * `features/session/term-mode` and `features/session/guided/pane-swipe` were
 * barrel-exported adapters that used to evaluate `document` access at import;
 * they are now cold-import pure, so the probe asserts they IMPORT cleanly. To
 * keep verifying the globals-stripped child harness really detects DOM
 * coupling, a deliberate canary module (requiring `document.body` at import,
 * which only the stripped harness can deny) must fail mentioning `document`.
 */

import { fileURLToPath } from "node:url";

const BROWSER_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "location",
  "history",
  "matchMedia",
  "HTMLElement",
  "Node",
  "visualViewport",
] as const;

type Result = { module: string; ok: boolean; error?: string };

const childModule = process.argv[2];
const presentDocument = process.argv[3] === "--present";
if (childModule) {
  for (const key of BROWSER_GLOBALS) {
    Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
  }
  if (presentDocument) {
    // Reverse control: only the DOM root is restored; every other browser
    // global stays stripped so the module's import path is identical.
    Object.defineProperty(globalThis, "document", { value: { documentElement: {} }, configurable: true, writable: true });
  }
  try {
    await import(childModule);
    console.log(JSON.stringify({ module: childModule, ok: true }));
    process.exit(0);
  } catch (error) {
    console.log(JSON.stringify({ module: childModule, ok: false, error: String(error) }));
    process.exit(1);
  }
}

/** Entire public owner/model entry, then the import-safe leaves. */
const SAFE = [
  "../src/features/session/index.ts",
  "../src/features/session/register.ts",
  "../src/features/session/model.ts",
  "../src/features/session/identity.ts",
  "../src/features/session/ports.ts",
  "../src/features/session/guided/model.ts",
  "../src/features/session/chat/model.ts",
  "../src/pages/session/index.ts",
] as const;

/** Former barrel exports that now cold-import pure (no import-time DOM read). */
const ADAPTERS = [
  "../src/features/session/term-mode.ts",
  "../src/features/session/guided/pane-swipe.ts",
] as const;

/** Isolated import-time DOM-access canary: MUST fail mentioning `document`. */
const CANARY = "../scripts/session-barrel-canary-document.ts";

/** Reverse control: with a document root present the same import must pass
 *  through the SAME generic child report (real exit code checked by run). */
const CANARY_PRESENT = "../scripts/session-barrel-canary-present.ts";

const self = fileURLToPath(import.meta.url);
const cwd = fileURLToPath(new URL("..", import.meta.url));

function run(module: string, present = false): Result {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, self, module, ...(present ? ["--present"] : [])],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(spawned.stdout).trim();
  let result: Result;
  try {
    result = JSON.parse(stdout) as Result;
  } catch {
    const stderr = new TextDecoder().decode(spawned.stderr).trim();
    result = { module, ok: false, error: stderr || stdout || `exit ${spawned.exitCode}` };
  }
  // The reported module must be the requested one (identity), and the real
  // child exit is authoritative: a non-zero exit is never ok:true, even when
  // the child printed `{"ok":true}` before failing.
  if (result.module !== module) {
    result = { module, ok: false, error: `child reported ${result.module} instead of ${module}` };
  } else if (result.ok && spawned.exitCode !== 0) {
    result = { module, ok: false, error: `${result.error ?? "ok:true"} (child exit ${spawned.exitCode})` };
  }
  return result;
}

const safe = SAFE.map((module) => run(module));
const adapters = ADAPTERS.map((module) => run(module));
const canary = run(CANARY);
const canaryPresent = run(CANARY_PRESENT, true);
const publicEntry = safe[0];
const adaptersPure = adapters.every((result) => result.ok);
const canaryDetected = !canary.ok && /document/i.test(canary.error ?? "");
const canaryPresentPasses = canaryPresent.ok;
const ok = publicEntry?.module === SAFE[0] && publicEntry.ok && safe.every((result) => result.ok) && adaptersPure && canaryDetected && canaryPresentPasses;

console.log(JSON.stringify({
  ok,
  publicEntry: SAFE[0],
  checked: safe.length,
  results: safe,
  adapters,
  canary,
  canaryPresent,
}, null, 2));
process.exit(ok ? 0 : 1);
