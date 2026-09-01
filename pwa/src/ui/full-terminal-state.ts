import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";

export type FullTerminalStage = "loading" | "opening" | "waiting" | "error" | "live";

export interface FullTerminalStateView {
  stage: FullTerminalStage;
  detail: string;
  retry: boolean;
  busy: boolean;
}

export class FullTerminalStatus {
  detail = "";
  stage: FullTerminalStage = "loading";
  private retryAvailable = false;

  constructor(private readonly repaint: () => void) {}

  set(detail: string, stage: FullTerminalStage = this.stage): void {
    this.detail = detail;
    this.stage = stage;
    this.repaint();
  }

  fail(detail: string): void {
    this.retryAvailable = true;
    this.set(detail, "error");
  }

  wait(detail: string): void {
    this.retryAvailable = false;
    this.set(detail, "waiting");
  }

  start(detail: string, stage: "opening" | "live"): void {
    this.retryAvailable = false;
    this.set(detail, stage);
  }

  reset(detail: string): void {
    this.retryAvailable = false;
    this.set(detail, "loading");
  }

  clearRetry(): void {
    this.retryAvailable = false;
  }

  sync(root: ParentNode, state: { active: boolean; busy: boolean; hasBridge: boolean }): void {
    syncFullTerminalState(root, {
      stage: this.stage,
      detail: this.detail,
      retry: state.active && this.retryAvailable && !state.busy && !state.hasBridge,
      busy: state.busy,
    });
  }
}

const FULL_TERMINAL_DOCUMENT_CLASS = "full-terminal-active";

export function setFullTerminalDocumentMode(active: boolean): void {
  document.documentElement.classList.toggle(FULL_TERMINAL_DOCUMENT_CLASS, active);
}

function title(stage: FullTerminalStage): string {
  switch (stage) {
    case "loading":
      return t("ft.stateLoading");
    case "opening":
      return t("ft.stateOpening");
    case "waiting":
      return t("ft.stateWaiting");
    case "error":
      return t("ft.stateError");
    case "live":
      return "";
  }
}

export function fullTerminalStateLayer(onRetry: () => void): HTMLElement {
  const layer = node("section", "full-terminal-state");
  layer.hidden = true;
  const spinner = node("span", "full-terminal-state-spinner");
  spinner.setAttribute("aria-hidden", "true");
  const copy = node("div", "full-terminal-state-copy");
  copy.append(
    node("strong", "full-terminal-state-title"),
    node("p", "full-terminal-state-detail"),
  );
  const retry = button(t("ft.retry"), "full-terminal-state-retry", onRetry);
  retry.hidden = true;
  layer.append(spinner, copy, retry);
  return layer;
}

export function syncFullTerminalState(root: ParentNode, view: FullTerminalStateView): void {
  const header = root.querySelector<HTMLElement>(".full-terminal-status");
  if (header) header.textContent = view.detail;

  const layer = root.querySelector<HTMLElement>(".full-terminal-state");
  if (!layer) return;
  layer.hidden = view.stage === "live";
  layer.dataset.stage = view.stage;
  layer.setAttribute("role", view.stage === "error" ? "alert" : "status");
  layer.setAttribute("aria-live", view.stage === "error" ? "assertive" : "polite");

  const heading = layer.querySelector<HTMLElement>(".full-terminal-state-title");
  if (heading) heading.textContent = title(view.stage);
  const detail = layer.querySelector<HTMLElement>(".full-terminal-state-detail");
  if (detail) detail.textContent = view.detail;
  const retry = layer.querySelector<HTMLButtonElement>(".full-terminal-state-retry");
  if (retry) {
    retry.hidden = !view.retry;
    retry.disabled = view.busy;
  }
}
