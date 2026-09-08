import { useLayoutEffect, useRef, useState } from "react";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../../lib/operations";
import { t } from "../../lib/i18n";
import { selectedAgent, state } from "../../state";
import { canSend, leaveAgentChat, sizeChatCompose, submitAgentPrompt } from "../agent-chat-controller";
import { publishAgentChatUI } from "../agent-chat-ui";
import { Button } from "./chrome";

/** The controller owns draft value/selection; React owns labels and availability. */
export function AgentCompose() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [limited, setLimited] = useState(false);
  const allowed = canSend();
  useLayoutEffect(() => {
    const field = input.current!;
    const bindings = new AbortController();
    const signal = bindings.signal;
    const initial = fitOperationPrompt(state.composeDraft);
    state.composeDraft = initial.text;
    field.value = initial.text;
    setLimited(initial.truncated);
    const syncDraft = () => {
      const fitted = fitOperationPrompt(field.value);
      state.composeDraft = fitted.text;
      field.value = fitted.text;
      setLimited(fitted.truncated);
      sizeChatCompose(field);
      publishAgentChatUI();
    };
    field.addEventListener("input", () => {
      if (state.composeIME) sizeChatCompose(field);
      else syncDraft();
    }, { signal });
    field.addEventListener("compositionstart", () => { state.composeIME = true; }, { signal });
    field.addEventListener("compositionend", () => { state.composeIME = false; syncDraft(); }, { signal });
    field.addEventListener("focus", () => { state.composeFocused = true; }, { signal });
    field.addEventListener("blur", () => { state.composeFocused = false; }, { signal });
    field.addEventListener("keydown", event => {
      if (event.isComposing || state.composeIME || event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void submitAgentPrompt();
    }, { signal });
    const frame = requestAnimationFrame(() => { if (field.isConnected) sizeChatCompose(field); });
    return () => { bindings.abort(); cancelAnimationFrame(frame); };
  }, []);
  return <div className="dock agent-dock">
    {selectedAgent()?.status === "blocked" && <div className="agent-confirm">
      <p className="agent-confirm-copy">{t("chat.waitingConfirm")}</p>
      <Button className="btn btn-small" onClick={() => leaveAgentChat()}>{t("chat.goConfirm")}</Button>
    </div>}
    <form className="dock-form" onSubmit={event => { event.preventDefault(); void submitAgentPrompt(); }}>
      <textarea ref={input} rows={1} enterKeyHint="send" maxLength={OPERATION_INPUT_LIMITS.prompt}
        placeholder={t(allowed ? "chat.placeholder" : "chat.cantSend")} disabled={!allowed || state.operationBusy} />
      <Button className="send-btn" disabled={!allowed || state.operationBusy || !state.composeDraft.trim()}
        onClick={() => void submitAgentPrompt()}>{t("compose.send")}</Button>
    </form>
    <p className="agent-compose-hint" aria-live="polite" hidden={!limited}>{limited ? t("chat.limit") : ""}</p>
  </div>;
}
