import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "HTMLDialogElement",
  "HTMLFormElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
  "FormData",
] as const;

/** Install a phone-sized happy-dom before importing PWA modules that touch `document`. */
export function attachHappyDom(url = "https://pairfob.com/pair"): Window {
  const existing = (globalThis as unknown as { document?: Document }).document;
  if (existing?.getElementById("app")) return globalThis as unknown as Window;
  const happy = new Window({ url, width: 390, height: 844 });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of GLOBALS) globals[name] = (happy as unknown as Record<string, unknown>)[name];
  globals.location = happy.location;
  globals.matchMedia = happy.matchMedia.bind(happy);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  happy.document.body.innerHTML = '<main id="app"></main>';
  return happy;
}

let root: Root | undefined;

export function renderReactScreen(host: HTMLElement, screen: ReactNode): void {
  root ??= createRoot(host);
  act(() => flushSync(() => root!.render(screen)));
}

export function leaveReactScreen(): void {
  if (!root) return;
  act(() => flushSync(() => root!.unmount()));
  root = undefined;
}
