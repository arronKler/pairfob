import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { app } from "../src/state";
import { setRenderer } from "../src/paint";
import { BoardScreen } from "../src/ui/react/board";

let root: Root | null = null;

export function renderReact(node: ReactNode): void {
  if (!root) root = createRoot(app);
  act(() => {
    root!.render(node as ReactElement);
  });
}

export function paintBoard(): void {
  renderReact(createElement(BoardScreen));
}

export function installBoardPainter(): void {
  setRenderer(paintBoard);
}

export function unmountReact(): void {
  act(() => {
    root?.unmount();
  });
  root = null;
  setRenderer(() => {});
}

export function click(label: string, host: ParentNode = app): HTMLButtonElement {
  const el = [...host.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${app.textContent?.slice(0, 320)}`);
  act(() => {
    el.click();
  });
  return el;
}
