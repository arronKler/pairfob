import { createElement } from "react";
import { ConnectScreen } from "./react/connect";
import { renderReactScreen } from "./react/root";

export function renderConnect(): void {
  renderReactScreen(createElement(ConnectScreen));
}
