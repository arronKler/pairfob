import { useEffect, useLayoutEffect } from "react";
import { appRoot } from "./dom-root";
import type { LayoutDescriptor } from "./layout";
import type { Immutable } from "../shared/model/domain-store";

/** The composition the shell follows; published data, so it is read-only here. */
export type ShellLayout = Immutable<LayoutDescriptor>;

/**
 * Shell ownership.
 *
 * The classes and custom properties that describe the whole application used to
 * be written by the paint function on every repaint. They belong to the mounted
 * application's lifecycle instead: `applyShell` is idempotent, the commit
 * pipeline applies it before React commits (so a child measuring in a layout
 * effect sees the shell it is inside), `useAppShell` re-applies it whenever the
 * composition changes, and unmounting removes it.
 */
const SHELL_CLASSES = ["session", "desk", "workspace", "board", "boot-screen"] as const;

export function applyShell(layout: ShellLayout): void {
  const root = appRoot();
  root.classList.toggle("session", layout.shell.session);
  root.classList.toggle("desk", layout.shell.desk);
  root.classList.toggle("workspace", layout.shell.workspace);
  root.classList.toggle("board", layout.shell.board);
  root.classList.toggle("boot-screen", layout.shell.booting);
  document.documentElement.classList.toggle("lock", layout.lockScroll);
  document.body.classList.toggle("lock", layout.lockScroll);
  root.style.setProperty("--term-fs", `${layout.termFontPx}px`);
  root.style.setProperty("--term-lh", `${layout.termLineHeightPx}px`);
  root.setAttribute("aria-busy", layout.operationBusy ? "true" : "false");
}

/**
 * Remove exactly what the shell owner added. An unmounted application must not
 * leave the document scroll-locked or keep terminal metrics on the root.
 */
export function clearShell(): void {
  const root = appRoot();
  for (const name of SHELL_CLASSES) root.classList.remove(name);
  root.removeAttribute("aria-busy");
  root.style.removeProperty("--term-fs");
  root.style.removeProperty("--term-lh");
  document.documentElement.classList.remove("lock");
  document.body.classList.remove("lock");
}

/**
 * Lifecycle-owned shell: re-applied when the composition changes, removed when
 * the application unmounts. Applying it twice in a row changes nothing.
 */
export function useAppShell(layout: ShellLayout | null): void {
  useLayoutEffect(() => {
    if (layout) applyShell(layout);
  }, [layout]);
  useEffect(() => clearShell, []);
}
