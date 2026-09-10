/**
 * Fresh-process import probe for the domain models.
 *
 * Run with `bun scripts/state-purity-probe.ts` from `pwa/`. It removes every
 * browser global first, then imports each state module: a model that reaches for
 * `window`, `navigator`, `localStorage` or `#app` during module evaluation fails
 * here, which is the property `src/app/domain-purity.test.ts` asserts.
 *
 * Importing after a Happy DOM fixture cannot demonstrate this, so the probe runs
 * in its own process.
 */

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

for (const key of BROWSER_GLOBALS) {
  Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
}

const MODULES = [
  // Framework-neutral shared model primitives: no React-DOM, no browser global.
  "../src/shared/model/domain-store.ts",
  "../src/shared/model/domain-environment.ts",
  "../src/shared/model/compose-transaction.ts",
  "../src/shared/react/use-domain.ts",
  // App boot boundary and composition coordination that must import cold.
  "../src/app/environment.ts",
  "../src/app/dom-root.ts",
  "../src/app/host.ts",
  "../src/app/layout.ts",
  "../src/app/layout-input.ts",
  "../src/app/layout-store.ts",
  "../src/app/frame.ts",
  "../src/app/domain-publication.ts",
  // The real domain owners (the shims re-export these; verify the owners cold).
  "../src/features/connection/connection-store.ts",
  "../src/features/connection/runtime-store.ts",
  "../src/features/computers/catalog-store.ts",
  "../src/features/pairing/form-store.ts",
  "../src/features/dashboard/catalog-store.ts",
  "../src/features/board/layout-store.ts",
  "../src/features/settings/preferences-store.ts",
  "../src/features/session/session-store.ts",
  "../src/features/session/compose-store.ts",
  "../src/features/session/chat/trace-store.ts",
  "../src/features/operations/capabilities-store.ts",
  "../src/app/navigation-store.ts",
  "../src/app/notices-store.ts",
] as const;

type Result = { module: string; ok: boolean; error?: string };

const results: Result[] = [];
for (const module of MODULES) {
  try {
    await import(module);
    results.push({ module, ok: true });
  } catch (error) {
    results.push({ module, ok: false, error: String(error) });
  }
}

const ok = results.every((result) => result.ok);
console.log(JSON.stringify({ ok, checked: results.length, results }, null, 2));
process.exit(ok ? 0 : 1);
