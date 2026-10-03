import type { zh } from "./i18n-zh";

/** English singular forms; the main catalog supplies zero and plural forms. */
export const enSingular: Partial<Record<keyof typeof zh, string>> = {
  "workspace.showMoreChanges": "Show {count} more change",
  "workspace.diffRenderLimit": "For smooth mobile rendering, only the first {count} line is shown.",
  "diffNotes.count": "{count} comment",
  "tabs.attentionAria": "{count} pane needs you",
  "list.markBlockedAria": "{count} pane waiting for you, jump there",
  "list.markDoneAria": "{count} pane just finished, jump there",
  "create.usedTimes": "Used {n} time",
  "detail.splitCount": "{n} pane",
  "home.pendingCount": "{count} needs you",
  "form.worktreesCount": "{n} worktree.",
  "trace.nTools": "Run · {n} tool",
  "trace.thinkN": "Run · thinking and {n} tool",
  "trace.runningSteps": "Running · {n} step",
  "trace.nSteps": "Run · {n} step",
  "compose.pendingStatus": "{n} character accepted locally, waiting for terminal echo",
  "term.jumpLines": "{n} new line",
};
