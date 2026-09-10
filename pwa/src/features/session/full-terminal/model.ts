/**
 * Pure complete-terminal view helpers. Do not import state, paint, or DOM.
 */

export type FullTerminalViewFields = {
  owner: string;
  paneId: string;
  title: string;
  working: boolean;
  stage: string;
  detail: string;
  retry: boolean;
  busy: boolean;
  composeLive: boolean;
  keyboardOpen: boolean;
};

export function fullTerminalHostIsPan(termFit: string): boolean {
  return termFit === "pan";
}

export function sameFullTerminalView(a: FullTerminalViewFields, b: FullTerminalViewFields): boolean {
  return (
    a.owner === b.owner &&
    a.paneId === b.paneId &&
    a.title === b.title &&
    a.working === b.working &&
    a.stage === b.stage &&
    a.detail === b.detail &&
    a.retry === b.retry &&
    a.busy === b.busy &&
    a.composeLive === b.composeLive &&
    a.keyboardOpen === b.keyboardOpen
  );
}
