/**
 * Globals-PRESENT reverse control for the DOM-access canary (probe fixture).
 *
 * Only installs a `document` root and imports the real canary module, which
 * evaluates `document.documentElement` at import. The probe spawns this through
 * the SAME generic child shell as every entry (with `--present`), so the
 * result and exit code come from the generic child report — this file never
 * prints its own JSON or exits itself. Probe-only; do not import elsewhere.
 */
globalThis.document = { documentElement: {} } as unknown as Document;
await import("./session-barrel-canary-document.ts");
