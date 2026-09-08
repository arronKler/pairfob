import { createElement } from "react";
import { ComputersScreen } from "./react/computers";
import { renderReactScreen } from "./react/root";

export function renderComputers(): void {
  renderReactScreen(createElement(ComputersScreen));
}
