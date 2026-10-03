import { useEffect, useState } from "react";
import { useChat, useSession } from "../hooks";
import { useDashboard } from "../../dashboard/hooks";
import { agentFromDashboardSnapshot } from "../agents";
import { t } from "../../../lib/i18n";
import { applyTrace, chatSnapshot } from "./trace-store";
import { observedPromptActivity, promptProgressMessage } from "./prompt-progress";
import type { PromptProgressNote } from "./agent-stream";

/** Outcomes that need the user to look at the terminal or wait. */
const ATTENTION = new Set(["promptProgress.busy", "promptProgress.blocked", "promptProgress.stalled", "promptProgress.unknown"]);
/** Confirmations the stream also shows (a live run, the user's own bubble). */
const TRANSIENT = new Set(["promptProgress.processing", "promptProgress.recorded"]);

/**
 * Delivery state of the last prompt, advanced from observed agent activity.
 * Agents other than Claude Code handle a leading "/" in the terminal and never
 * record it, so such a prompt settles as "sent to the terminal" instead of
 * waiting forever.
 */
export function usePromptProgressNote(): PromptProgressNote | null {
  const chat = useChat();
  const progress = chat.promptProgress;
  const agent = agentFromDashboardSnapshot(useDashboard(), useSession().paneId);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!progress || progress.phase !== "submitted") return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, progress.startedAt + 8000 - Date.now()));
    return () => clearTimeout(timer);
  }, [progress]);
  useEffect(() => {
    if (progress?.phase === "submitted" && agent && observedPromptActivity(progress, agent)
      && chatSnapshot().promptProgress?.startedAt === progress.startedAt) {
      applyTrace({ promptProgress: { ...progress, phase: "processing" } });
    }
  }, [progress, agent]);
  const message = promptProgressMessage(progress, agent, now);
  if (!message) return null;
  const pending = chat.agentTracePending.trim();
  const local = pending.startsWith("/") && agent?.agent !== "claude" && progress?.phase !== "sending" && progress?.phase !== "unknown";
  if (local) return { message: t("pending.local"), attention: false, settled: true };
  return { message: t(message), attention: ATTENTION.has(message), settled: TRANSIENT.has(message) || ATTENTION.has(message) };
}

/**
 * Fallback line above the composer for a delivery outcome that needs attention
 * after the prompt itself left the stream (for example an unknown outcome).
 * While the prompt is pending, its turn shows the state instead.
 */
export function PromptProgressView() {
  const note = usePromptProgressNote();
  const pending = useChat().agentTracePending.trim();
  if (!note || pending || !note.attention) return null;
  return <p className="agent-progress is-attention" role="status" aria-live="polite" data-prompt-progress="">{note.message}</p>;
}
