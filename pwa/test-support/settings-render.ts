import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { app, state } from "../src/state";
import { setRenderer } from "../src/paint";
import { QuotaScreen } from "../src/ui/react/agent-quota";
import { ComputersScreen } from "../src/ui/react/computers";
import { SettingsContent, SettingsScreen } from "../src/ui/react/settings";

let root: Root | null = null;
export function mount(node: ReactNode): void {
  if (!root) root = createRoot(app);
  act(() => {
    root!.render(node as ReactElement);
  });
}

export function update(node: ReactNode): void {
  mount(node);
}

export function paintApp(): void {
  if (state.screen === "quota") mount(createElement(QuotaScreen));
  else if (state.screen === "computers") mount(createElement(ComputersScreen));
  else if (state.screen === "settings") mount(createElement(SettingsScreen));
  else mount(createElement("div"));
}

export function paintSettings(withBack = false): void {
  mount(createElement(SettingsContent, { withBack }));
}

export function installPainter(): void {
  setRenderer(paintApp);
}

export function installSettingsPainter(withBack = false): void {
  setRenderer(() => paintSettings(withBack));
}

export function resetRoot(): void {
  act(() => root?.unmount());
  root = null;
  app.replaceChildren();
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

export async function flushed(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
