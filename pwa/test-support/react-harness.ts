import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appRoot } from "../src/app/dom-root";
import { commitView } from "../src/app/host";
import { isAppMounted, mountApp, unmountApp } from "../src/app/mount";
import { registerSessionOwnerPreparer, sessionOwnerPreparer } from "../src/app/frame";
import { registerSessionView } from "../src/features/session/register";

/**
 * Generic React test harness. Two explicit fixture boundaries:
 *
 * 1. Single-component fixture (`renderReact` / `unmountReact`): a standalone
 *    React root for tests that render ONE feature component in isolation
 *    (rails, pads, rows). This is a deliberate test boundary, never a page
 *    renderer: it must not be used to paint whole screens, and it never wires
 *    the production paint bridge. The root lives on the same `#app` element and
 *    is unmounted explicitly at teardown.
 *
 * 2. Application fixture (`mountTestApp` / `unmountTestApp`): mounts the SAME
 *    stable production App the browser boots (`app/mount.tsx`) with the real
 *    session-owner seam, so cross-feature fixtures drive named domain actions
 *    and commit through the mounted host.
 */

let componentRoot: Root | null = null;

/** Render one feature component into the standalone test root (component fixture only). */
export function renderReact(node: ReactNode): void {
  if (!componentRoot) componentRoot = createRoot(appRoot());
  act(() => {
    componentRoot!.render(node as ReactElement);
  });
}

/** Unmount the standalone component fixture root. Idempotent. */
export function unmountReact(): void {
  act(() => {
    componentRoot?.unmount();
  });
  componentRoot = null;
}

/**
 * Mount the stable production App for a page/cross-feature fixture.
 * Idempotent: an already mounted App keeps its root and host.
 */
export function mountTestApp(): void {
  if (isAppMounted()) return;
  act(() => {
    if (!sessionOwnerPreparer()) registerSessionOwnerPreparer(registerSessionView);
    mountApp();
  });
}

/** Force a fixture commit through the mounted host inside act. */
export function commitTest(): void {
  act(() => {
    commitView();
  });
}

/** True while the application fixture is mounted. */
export function appMounted(): boolean {
  return isAppMounted();
}

/**
 * Unmount the application fixture and release every seam it registered.
 * Idempotent and safe to call after component-only fixtures.
 */
export function unmountTestApp(): void {
  act(() => {
    registerSessionOwnerPreparer(null);
    unmountApp();
  });
}

/** Click a button by aria-label or text content, inside act. Returns the button. */
export function click(label: string, host: ParentNode = appRoot()): HTMLButtonElement {
  const el = [...host.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${appRoot().textContent?.slice(0, 320)}`);
  act(() => {
    el.click();
  });
  return el;
}

// Re-exported for existing component-fixture callers during staged migration.
export { createElement };
