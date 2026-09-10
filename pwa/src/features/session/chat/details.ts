/**
 * Manual <details> choices for the agent stream. Scoped to the adopted session
 * owner. Controllers record toggles; render must not snapshot the DOM.
 */

export type DetailsState = {
  open: Set<string>;
  closed: Set<string>;
};

let boundKey = "";
let open = new Set<string>();
let closed = new Set<string>();

export function emptyDetailsState(): DetailsState {
  return { open: new Set(), closed: new Set() };
}

export function adoptChatDetailsOwner(key: string): void {
  if (boundKey === key) return;
  boundKey = key;
  open = new Set();
  closed = new Set();
}

export function chatDetailsOwner(): string {
  return boundKey;
}

/** Record a choice only for the owner that captured the event. Retired owners no-op. */
export function recordChatDetailChoice(traceKey: string, opened: boolean, owner = boundKey): boolean {
  if (owner !== boundKey) return false;
  if (opened) {
    open.add(traceKey);
    closed.delete(traceKey);
  } else {
    closed.add(traceKey);
    open.delete(traceKey);
  }
  return true;
}

export function chatDetailChoice(traceKey: string): boolean | null {
  if (closed.has(traceKey)) return false;
  if (open.has(traceKey)) return true;
  return null;
}

export function chatDetailsState(): DetailsState {
  return { open: new Set(open), closed: new Set(closed) };
}

export function resetChatDetails(): void {
  boundKey = "";
  open = new Set();
  closed = new Set();
}

export function choiceFromDetails(kept: DetailsState | undefined, traceKey: string): boolean | null {
  if (kept?.closed.has(traceKey)) return false;
  if (kept?.open.has(traceKey)) return true;
  return chatDetailChoice(traceKey);
}
