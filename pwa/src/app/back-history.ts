/**
 * One disposable browser entry while the UI has a way back, not a route log.
 * Only an opaque page token is serialized. The UI remains the authority and
 * Forward cannot resurrect a file, a dismissed dialog, or another computer.
 * Same-entry events (including iframe history) belong to the browser.
 *
 * Chromium's back UI skips entries a document adds without a user activation,
 * and stops honouring the activation once a back or forward has run. With every
 * entry skipped, Android has nowhere to go and closes the app. So an
 * application Back never adds an entry: it runs the UI's own way back, then
 * returns to the entry it came from, which is still in history for the next
 * press. An entry is added only after a gesture in this document, and only when
 * no guard entry is left to reuse.
 */
export type BackHistoryPort = {
  state(): unknown;
  replace(state: unknown): void;
  push(state: unknown): void;
  back(): void;
  forward(): void;
  listen(pop: () => void): () => void;
  /** Trusted activations only: the proof the back UI needs before it stops skipping added entries. */
  listenGesture?(gesture: () => void): () => void;
};
const KEY = "pairfobBack";
type Mark = { token: string; guard: boolean };
/** Where the guard entry is: the current one, ahead of it, or nowhere. */
type Guard = "here" | "ahead" | "none";
function mark(state: unknown): Mark | undefined {
  if (!state || typeof state !== "object") return;
  const value = (state as Record<string, unknown>)[KEY];
  if (!value || typeof value !== "object") return;
  const item = value as Mark;
  return typeof item.token === "string" && typeof item.guard === "boolean" ? item : undefined;
}
function stamped(state: unknown, value: Mark): unknown {
  return { ...(state && typeof state === "object" ? state : {}), [KEY]: value };
}

export function bindBackHistory(port: BackHistoryPort, action: () => (() => void | Promise<void>) | null, token: string) {
  let alive = true;
  let handling = false;
  let retiring = false;
  let forwarding = false;
  // Adopt a refreshed document's existing guard rather than stack another one.
  const previous = mark(port.state());
  const pageToken = previous?.token ?? token;
  let guard: Guard = previous?.guard === true ? "here" : "none";
  // An added entry is skipped until a gesture proves the document is in use.
  let activated = false;
  const write = (value: boolean) => stamped(port.state(), { token: pageToken, guard: value });
  if (!previous) port.replace(write(false));

  /** Return to the entry this Back left behind; it stays in history, so nothing is added. */
  const restore = () => {
    if (guard !== "ahead") return;
    forwarding = true;
    port.forward();
  };

  const sync = () => {
    if (!alive || handling || retiring || forwarding) return;
    if (action()) {
      if (guard === "ahead") restore();
      else if (guard === "none" && activated) { port.push(write(true)); guard = "here"; }
    } else if (guard === "here") {
      retiring = true;
      port.back();
    }
  };

  const pop = () => {
    if (!alive) return;
    const target = mark(port.state());
    if (target?.token !== pageToken) {
      // Never redirect unrelated navigation, including an iframe's own entries.
      if (forwarding) { forwarding = false; sync(); return; }
      // Our entry is behind an unrelated one: there is no guard left to reuse.
      if (retiring) { retiring = false; guard = "none"; sync(); }
      return;
    }
    const was = guard;
    guard = target.guard ? "here" : was === "here" ? "ahead" : "none";
    if (retiring) { retiring = false; sync(); return; }
    if (forwarding) { forwarding = false; sync(); return; }
    if (guard === "here") {
      // The reader's own Forward, not a layer the application answers.
      activated = false;
      sync();
      return;
    }
    if (was !== "here") { sync(); return; }
    // A Back the application did not start: one UI layer, and this press adds
    // nothing to history, so the back UI keeps a reachable entry.
    activated = false;
    if (handling) { restore(); return; }
    const back = action();
    if (!back) { sync(); return; }
    handling = true;
    let done: void | Promise<void>;
    try { done = back(); } catch { done = undefined; }
    // A way back that is still there keeps the guard: leave the app only once
    // the UI really has nowhere to go.
    if (action()) restore();
    Promise.resolve(done).finally(() => { handling = false; sync(); }).catch(() => {});
  };
  const stop = port.listen(pop);
  const stopGesture = port.listenGesture?.(() => {
    if (!alive || activated) return;
    activated = true;
    sync();
  }) ?? (() => {});
  sync();
  return {
    sync,
    /** A consumed notification hash added an entry; fold it into our boundary. */
    consumeHashEntry() {
      if (!alive) return;
      port.replace(write(true));
      guard = "here";
      if (retiring || forwarding) return;
      retiring = true;
      port.back();
    },
    dispose() { alive = false; stop(); stopGesture(); },
  };
}
