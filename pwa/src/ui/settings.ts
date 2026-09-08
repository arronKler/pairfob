import { createElement } from "react";
import { SettingsScreen } from "./react/settings";
import { renderReactScreen } from "./react/root";

export function renderSettings(): void {
  renderReactScreen(createElement(SettingsScreen));
}
