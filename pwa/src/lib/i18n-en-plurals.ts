import type { zh } from "./i18n-zh";
import { enChatWorkSingular } from "./i18n-chat-work";

/** English singular forms; the main catalog supplies zero and plural forms. */
export const enSingular: Partial<Record<keyof typeof zh, string>> = {
  ...enChatWorkSingular,
  "workspace.showMoreChanges": "Show {count} more change",
  "workspace.diffRenderLimit": "For smooth mobile rendering, only the first {count} line is shown.",
  "diffNotes.count": "{count} comment",
  "tabs.attentionAria": "{count} session needs you",
  "list.markBlockedAria": "{count} session waiting for you, jump there",
  "list.markDoneAria": "{count} session just finished, jump there",
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
