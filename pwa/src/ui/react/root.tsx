import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { app } from "../../state";

let root: Root | undefined;

/** Commit before navigation code measures scroll or focuses an input. */
export function renderReactScreen(screen: ReactNode): void {
  root ??= createRoot(app);
  flushSync(() => root!.render(screen));
}

/** Release the app root when its mounted screen lifecycle is explicitly retired. */
export function leaveReactScreen(): void {
  if (!root) return;
  root.unmount();
  root = undefined;
}
