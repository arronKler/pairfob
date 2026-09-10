import { useLayoutEffect, useRef, useState } from "react";
import { operationBusy } from "../../operations/capabilities-store";
import {
  composeDraft,
  composeIME,
  finishComposeComposition,
  setComposeDraft,
  setComposeFocused,
  setComposeIME,
} from "../compose-store";
import { liveSession } from "../../computers/catalog-store";
import { openPaneId } from "../session-store";
import { useCompose, useSession } from "../hooks";
import { useDashboard } from "../../dashboard/hooks";
import { currentViewIncarnation } from "../drafts/compose-drafts";
import { agentFromDashboardSnapshot } from "../agents";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import { canSend, leaveAgentChat, sizeChatCompose, submitAgentPrompt } from "./agent-chat-controller";
import { publishAgentChatUI } from "./agent-chat-ui";
import { Button } from "../../../shared/ui/primitives";

function composeOwnerMoved(
  session: ReturnType<typeof liveSession>,
  paneId: string,
  incarnation: number,
): boolean {
  return liveSession() !== session || openPaneId() !== paneId || currentViewIncarnation() !== incarnation;
}

/** The controller owns draft value/selection; React owns labels and availability. */
export function AgentCompose() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [limited, setLimited] = useState(false);
  const allowed = canSend();
  const busy = operationBusy();
  const draft = useCompose().composeDraft;
  const selected = agentFromDashboardSnapshot(useDashboard(), useSession().paneId);
  useLayoutEffect(() => {
    const field = input.current!;
    const bindings = new AbortController();
    const signal = bindings.signal;
    const initial = fitOperationPrompt(composeDraft());
    setComposeDraft(initial.text);
    field.value = initial.text;
    setLimited(initial.truncated);
    const syncDraft = () => {
      const session = liveSession();
      const paneId = openPaneId();
      const incarnation = currentViewIncarnation();
      const fitted = fitOperationPrompt(field.value);
      setComposeDraft(fitted.text);
      if (composeOwnerMoved(session, paneId, incarnation) || !field.isConnected) return;
      field.value = fitted.text;
      setLimited(fitted.truncated);
      sizeChatCompose(field);
      publishAgentChatUI();
    };
    field.addEventListener("input", () => {
      if (composeIME()) sizeChatCompose(field);
      else syncDraft();
    }, { signal });
    field.addEventListener("compositionstart", () => { setComposeIME(true); }, { signal });
    field.addEventListener("compositionend", () => {
      const session = liveSession();
      const paneId = openPaneId();
      const incarnation = currentViewIncarnation();
      const fitted = fitOperationPrompt(field.value);
      finishComposeComposition(fitted.text);
      if (composeOwnerMoved(session, paneId, incarnation) || !field.isConnected) return;
      field.value = fitted.text;
      setLimited(fitted.truncated);
      sizeChatCompose(field);
      publishAgentChatUI();
    }, { signal });
    field.addEventListener("focus", () => { setComposeFocused(true); }, { signal });
    field.addEventListener("blur", () => { setComposeFocused(false); }, { signal });
    field.addEventListener("keydown", event => {
      if (event.isComposing || composeIME() || event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void submitAgentPrompt();
    }, { signal });
    const frame = requestAnimationFrame(() => { if (field.isConnected) sizeChatCompose(field); });
    return () => { bindings.abort(); cancelAnimationFrame(frame); };
  }, []);
  return <div className="dock agent-dock">
    {selected?.status === "blocked" && <div className="agent-confirm">
      <p className="agent-confirm-copy">{t("chat.waitingConfirm")}</p>
      <Button className="btn btn-small" onClick={() => leaveAgentChat()}>{t("chat.goConfirm")}</Button>
    </div>}
    <form className="dock-form" onSubmit={event => { event.preventDefault(); void submitAgentPrompt(); }}>
      <textarea ref={input} rows={1} enterKeyHint="send" maxLength={OPERATION_INPUT_LIMITS.prompt}
        placeholder={t(allowed ? "chat.placeholder" : "chat.cantSend")} disabled={!allowed || busy} />
      <Button className="send-btn" disabled={!allowed || busy || !draft.trim()}
        onClick={() => void submitAgentPrompt()}>{t("compose.send")}</Button>
    </form>
    <p className="agent-compose-hint" aria-live="polite" hidden={!limited}>{limited ? t("chat.limit") : ""}</p>
  </div>;
}
