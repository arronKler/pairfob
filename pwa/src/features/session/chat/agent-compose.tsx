import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { useChat, useCompose, useSession } from "../hooks";
import { useDashboard } from "../../dashboard/hooks";
import { currentViewIncarnation } from "../drafts/compose-drafts";
import { agentFromDashboardSnapshot } from "../agents";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import { showError } from "../../../app/notices-store";
import { appRoot } from "../../../app/dom-root";
import { hardwareKeyboard, useHardwareKeyboard } from "../../../app/input-mode";
import { canSend, leaveAgentChat, refreshAgentTrace, stickAgentStream, submitAgentPrompt } from "./agent-chat-controller";
import { publishAgentChatUI } from "./agent-chat-ui";
import { pageAgentStreamFromField } from "./reading-keys";
import { Button } from "../../../shared/ui/primitives";
import { AttachButton } from "../attachments/attach-button";
import { fitComposeHeight } from "../compose-size";
import { phoneEnterKeyHint, returnAddsNewline } from "../compose-keys";
import { acceptComposePaste, attachmentMessage, markSentAttachments, requestSend, resetSendGate } from "../guided/send-gate";
import { AttachmentTray } from "../attachments/attachment-tray";
import { useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { usePreferences } from "../../settings/hooks";
import { ComposeFrame, SendButton, SendIssuePopover, useSendKind } from "../guided/compose-controls";
import { cancelStop, type StopTarget } from "../guided/session-stop";
import { useDeskPointer, useKeyboardHintsInPlace } from "../desk-pointer";

function composeOwnerMoved(
  session: ReturnType<typeof liveSession>,
  paneId: string,
  incarnation: number,
): boolean {
  return liveSession() !== session || openPaneId() !== paneId || currentViewIncarnation() !== incarnation;
}

/** Grow with the draft and keep a following stream on its tail. */
function sizeField(field: HTMLTextAreaElement): void {
  fitComposeHeight(field);
  stickAgentStream();
}

function showDraft(text: string): void {
  setComposeDraft(text);
  const field = appRoot().querySelector<HTMLTextAreaElement>(".agent-dock textarea");
  if (!field) return;
  field.value = text;
  sizeField(field);
}

/**
 * A character typed on a hardware keyboard while the conversation, not the
 * field, has the keyboard: it starts or continues the draft and takes the caret
 * there, as the guided session and the complete terminal do. Space stays the
 * transcript's page-down, and a chord (copy, the browser's own keys) is never a
 * character. Where typing means glass, nothing here runs: focusing the field
 * would raise the keys under a reader.
 */
export function typeIntoAgentCompose(event: KeyboardEvent): void {
  if (!hardwareKeyboard() || event.isComposing || composeIME()) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || event.key === " ") return;
  const field = appRoot().querySelector<HTMLTextAreaElement>(".agent-dock textarea");
  if (!field || field.disabled) return;
  event.preventDefault();
  field.value += event.key;
  field.focus({ preventScroll: true });
  field.setSelectionRange(field.value.length, field.value.length);
  // The field's own input handler fits the draft to the limit and publishes it.
  const EventCtor = field.ownerDocument.defaultView?.Event;
  if (EventCtor) field.dispatchEvent(new EventCtor("input", { bubbles: true }));
}

/**
 * Send the prompt with its ready attachments: draft, a blank line, then one
 * path per line (see send-gate). The prompt path reads the visible draft, so
 * the message is placed there for the submit. It is put back to what the
 * reader wrote when the prompt did not go (refused, or a failure that restored
 * it), so a retry cannot carry the paths twice; the tray is cleared only once
 * the prompt left.
 */
export function submitAgentMessage(): Promise<void> {
  return Promise.resolve(requestSend(async (paths) => {
    if (!paths.length) {
      await submitAgentPrompt();
      return;
    }
    const draft = composeDraft();
    const message = attachmentMessage(draft, paths);
    if (fitOperationPrompt(message).truncated) {
      showError(t("compose2.tooLong"));
      return;
    }
    showDraft(message);
    await submitAgentPrompt();
    if (composeDraft() === message) {
      showDraft(draft);
      return;
    }
    markSentAttachments();
  }));
}

/** The controller owns draft value/selection; React owns labels and availability. */
export function AgentCompose() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [limited, setLimited] = useState(false);
  const allowed = canSend();
  const busy = operationBusy();
  const compose = useCompose();
  const follow = useChat().agentTraceFollow;
  const draft = compose.composeDraft;
  const paneId = useSession().paneId;
  const selected = agentFromDashboardSnapshot(useDashboard(), paneId);
  usePreferences();
  // Return adds a line only where there is no Shift+Enter: the keyboard decides, not the width.
  const phone = !useHardwareKeyboard();
  const send = useSendKind({ paneId, hasText: Boolean(draft.trim()), live: false, submitting: false });
  const hasMessage = Boolean(draft.trim()) || send.attachments.readyPaths.length > 0;
  const keyboardOpen = useSoftKeyboardOpen();
  const pointer = useDeskPointer();
  const keysInPlace = useKeyboardHintsInPlace();
  const stopTarget = useMemo<StopTarget | null>(() => paneId ? {
    paneId,
    sendKey: async (key) => {
      const session = liveSession();
      if (!session) throw new Error("disconnected");
      await session.sendKeys(paneId, [key], { intent: "pad" });
      void refreshAgentTrace();
    },
  } : null, [paneId]);
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
      sizeField(field);
      publishAgentChatUI();
    };
    field.addEventListener("input", () => {
      if (composeIME()) sizeField(field);
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
      sizeField(field);
      publishAgentChatUI();
    }, { signal });
    field.addEventListener("focus", () => { setComposeFocused(true); }, { signal });
    field.addEventListener("blur", () => { setComposeFocused(false); }, { signal });
    field.addEventListener("paste", acceptComposePaste, { signal });
    field.addEventListener("keydown", event => {
      if (pageAgentStreamFromField(event, field)) return;
      if (event.isComposing || composeIME() || event.key !== "Enter" || event.shiftKey) return;
      if (returnAddsNewline(event, !hardwareKeyboard())) return;
      event.preventDefault();
      void submitAgentMessage();
    }, { signal });
    const frame = requestAnimationFrame(() => { if (field.isConnected) sizeField(field); });
    return () => { bindings.abort(); cancelAnimationFrame(frame); };
  }, []);
  useLayoutEffect(() => () => { resetSendGate(); cancelStop(); }, [paneId]);
  const prompt = t(!allowed ? "chat.cantSendPh" : selected?.status === "working" ? "chat.placeholderWorking" : "chat.placeholder");
  // A tablet with a keyboard has no hint line under the field: the field says what Enter does.
  const placeholder = keysInPlace && allowed ? `${prompt} · ${t("deskDock.hintChat")}` : prompt;
  return <div className="dock agent-dock">
    {/* The needs-you card sits in the latest turn; this entry covers a reader scrolled away from it. */}
    {selected?.status === "blocked" && !follow && <div className="agent-confirm">
      <p className="agent-confirm-copy">{t("chat.waitingConfirm")}</p>
      <Button className="btn btn-small" onClick={() => leaveAgentChat()}>{t("needs.go")}</Button>
    </div>}
    <AttachmentTray compact={keyboardOpen} />
    <form className="dock-form" onSubmit={event => { event.preventDefault(); void submitAgentMessage(); }}>
      <AttachButton />
      <ComposeFrame field={input} draft={draft} live={false} focused={compose.composeFocused} foldable={phone}
        onResize={() => { if (input.current) sizeField(input.current); }}>
        <textarea ref={input} rows={1} enterKeyHint={phone ? phoneEnterKeyHint() : "send"} maxLength={OPERATION_INPUT_LIMITS.prompt}
          placeholder={placeholder}
          disabled={!allowed || busy} />
      </ComposeFrame>
      <div className="send-slot">
        <SendIssuePopover attachments={send.attachments} />
        <SendButton
          kind={send.kind === "enter" ? "send" : send.kind}
          percent={send.attachments.pendingPercent}
          className="send-btn"
          // A prompt is never a bare Enter: with nothing to send the button rests.
          disabled={(send.kind === "send" || send.kind === "enter") && (!allowed || busy || !hasMessage)}
          onSend={() => void submitAgentMessage()}
          stopTarget={stopTarget}
          longPressStops={send.working}
        />
      </div>
    </form>
    {/* The same quiet line the guided and terminal docks carry under their field; a finger has no Shift+Enter to be told about. */}
    {pointer && <div className="dock-mode"><p className="dock-mode-hint"><span>{t("deskDock.hintChat")}</span></p></div>}
    <p className="agent-compose-hint" aria-live="polite" hidden={!limited}>{limited ? t("chat.limit") : ""}</p>
  </div>;
}
