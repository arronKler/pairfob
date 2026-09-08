import { createElement } from "react";
import { HomeScreen, prepareHerdView } from "./react/home";
import { renderReactScreen } from "./react/root";

export function renderHome(): void {
  renderReactScreen(createElement(HomeScreen, { view: prepareHerdView() }));
}
