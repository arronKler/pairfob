import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { HomePage } from "../../../pages/home";
import { presentHerdView as prepareHerdView } from "../../../pages/home/herd-bridge";

export type PaneUnderlay = { element: HTMLDivElement; dispose(): void };

/** The adapter owns the container; React owns the complete borrowed list inside. */
export function mountPaneUnderlay(app: HTMLElement, transform: string): PaneUnderlay {
  const element = document.createElement("div");
  element.className = "pane-under";
  element.setAttribute("aria-hidden", "true");
  element.style.transform = transform;
  const root = createRoot(element);
  // Prepare before render: consume dashboard attention and reconcile the
  // accordion defaults outside React; the real HomePage subscribes to the
  // published attention so the underlay stays consistent with the main list.
  prepareHerdView();
  // Keep the original sibling order: underlay first, current pane above it.
  app.insertBefore(element, app.firstChild);
  flushSync(() => root.render(<HomePage />));
  let disposed = false;
  return { element, dispose() {
    if (disposed) return;
    disposed = true;
    // A replacement app root can already have detached this container. Its
    // children still belong to this root and remain safe to unmount here.
    flushSync(() => root.unmount());
    element.remove();
  } };
}