import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { HomeScreen, prepareHerdView } from "./home";

export type PaneUnderlay = { element: HTMLDivElement; dispose(): void };

/** The adapter owns the container; React owns the complete borrowed list inside. */
export function mountPaneUnderlay(app: HTMLElement, transform: string): PaneUnderlay {
  const element = document.createElement("div");
  element.className = "pane-under";
  element.setAttribute("aria-hidden", "true");
  element.style.transform = transform;
  const root = createRoot(element);
  const view = prepareHerdView();
  // Keep the original sibling order: underlay first, current pane above it.
  app.insertBefore(element, app.firstChild);
  flushSync(() => root.render(<HomeScreen view={view} />));
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
