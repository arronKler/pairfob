import { t } from "../lib/i18n";

export type FullTerminalStage = "loading" | "opening" | "waiting" | "error" | "live";

export class FullTerminalStatus {
  detail = "";
  stage: FullTerminalStage = "loading";
  private retryAvailable = false;

  constructor(private readonly repaint: () => void) {}

  get retry(): boolean {
    return this.retryAvailable;
  }

  set(detail: string, stage: FullTerminalStage = this.stage): void {
    if (this.detail === detail && this.stage === stage) return;
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
}

const FULL_TERMINAL_DOCUMENT_CLASS = "full-terminal-active";

export function setFullTerminalDocumentMode(active: boolean): void {
  document.documentElement.classList.toggle(FULL_TERMINAL_DOCUMENT_CLASS, active);
}

export function fullTerminalStateTitle(stage: FullTerminalStage): string {
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
