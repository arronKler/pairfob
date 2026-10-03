import { useEffect, useState } from "react";
import { useChat, useSession } from "../hooks";
import { useDashboard } from "../../dashboard/hooks";
import { agentFromDashboardSnapshot } from "../agents";
import { t } from "../../../lib/i18n";
import { applyTrace, chatSnapshot } from "./trace-store";
import { observedPromptActivity, promptProgressMessage } from "./prompt-progress";

/** Confirmations the stream also shows (a live run, the user's own bubble). */
const TRANSIENT = new Set(["promptProgress.processing", "promptProgress.recorded"]);
/** Outcomes that need the user to look at the terminal or wait. */
const ATTENTION = new Set(["promptProgress.busy", "promptProgress.blocked", "promptProgress.stalled", "promptProgress.unknown"]);

export function PromptProgressView({ confirmMs = 4000 }: { confirmMs?: number }) {
  const progress = useChat().promptProgress;
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
  // A confirmation is acknowledged briefly, then yields to the stream.
  const key = progress && message ? `${progress.startedAt}:${message}` : "";
  const [dismissed, setDismissed] = useState("");
  useEffect(() => {
    if (!key || !TRANSIENT.has(message!)) return;
    const timer = setTimeout(() => setDismissed(key), confirmMs);
    return () => clearTimeout(timer);
  }, [key, message, confirmMs]);
  if (!message || dismissed === key) return null;
  return <p className={`agent-progress${ATTENTION.has(message) ? " is-attention" : ""}`} role="status" aria-live="polite"
    data-prompt-progress="">{t(message)}</p>;
}
