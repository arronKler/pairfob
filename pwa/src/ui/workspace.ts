import { createElement } from "react";
import { renderReactScreen } from "./react/root";
import { WorkspaceScreen } from "./react/workspace";

/** Compatibility entry point for controller-driven workspace paints. */
export function renderWorkspace(): void {
  renderReactScreen(createElement(WorkspaceScreen));
}
