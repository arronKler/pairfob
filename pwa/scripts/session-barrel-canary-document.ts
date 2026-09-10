/**
 * Deliberate isolated import-time DOM-access canary (probe fixture).
 *
 * A real top-level DOM read: `document.documentElement` is evaluated when this
 * module is imported through the SAME stripped child Bun process every purity
 * entry uses (browser globals removed). With `document` absent the property
 * read throws, and the thrown reason names the accessed member
 * ("...reading 'documentElement'"), so the probe's `/document/i` detection
 * attributes the failure to DOM coupling. Its reverse control
 * (`session-barrel-canary-present.ts`) installs a `document` root and then
 * imports the very same module successfully, proving the failure is caused by
 * the stripped DOM global and not a hardcoded throw. Probe-only: nothing else
 * imports this file.
 */
// Real code, not a stage: reading the DOM root at import time.
export const canaryDocumentElement = document.documentElement;
