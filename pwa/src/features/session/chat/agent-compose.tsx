import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { useAgentCard, useChatField, useComposeDraft, useComposeFocused, usePaneId } from "../hooks";
import { currentViewIncarnation } from "../drafts/compose-drafts";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import { showError } from "../../../app/notices-store";
import { appRoot } from "../../../app/dom-root";
import { hardwareKeyboard, hasTouch, useHardwareKeyboard } from "../../../app/input-mode";
import { canSend, leaveAgentChat, refreshAgentTrace, stickAgentStream, submitAgentPrompt } from "./agent-chat-controller";
import { publishAgentChatUI } from "./agent-chat-ui";
import { pageAgentStreamFromField } from "./reading-keys";
import { Button, Fold } from "../../../shared/ui/primitives";
import { AttachButton } from "../attachments/attach-button";
import { currentAttachmentScope } from "../attachments/attachments-context";
import { markAttachmentsSent } from "../attachments/attachments-send";
import { fitComposeHeight } from "../compose-size";
import { phoneEnterKeyHint, returnAddsNewline } from "../compose-keys";
import { acceptComposePaste, attachmentMessage, requestSend, resetSendGate } from "../guided/send-gate";
import { AttachmentTray } from "../attachments/attachment-tray";
import { useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { usePreferenceField } from "../../settings/hooks";
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
  fitComposeHeight(field, agentFieldMinPx());
  stickAgentStream();
}

/**
 * The chat dock's field rests as tall as its frame's field row: 36px in the
 * two-row frame a fine pointer gets, 44px in the one row a finger gets. The
 * pointer decides, not the width, so a narrow window driven by a mouse keeps
 * the mouse's frame and a wide touch tablet keeps the finger's.
 */
const FIELD_MIN_FINE_PX = 36;
const FIELD_MIN_COARSE_PX = 44;
const COARSE_POINTER = "(any-pointer: coarse)";

function agentFieldMinPx(): number {
  return hasTouch() ? FIELD_MIN_COARSE_PX : FIELD_MIN_FINE_PX;
}

function subscribeCoarsePointer(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(COARSE_POINTER);
  media.addEventListener?.("change", listener);
  return () => media.removeEventListener?.("change", listener);
}

/** {@link hasTouch} for a component that must re-fit when the pointer changes. */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarsePointer, hasTouch, () => false);
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
 * reader wrote when the prompt failed, so a retry cannot carry the paths
 * twice; the tray is cleared only once the prompt left, and only for the pane
 * it was sent from (the reader may switch panes while it is on the wire).
 */
export function submitAgentMessage(): Promise<void> {
  return Promise.resolve(requestSend(async (paths) => {
    if (!paths.length) {
      await submitAgentPrompt();
      return;
    }
    // Capture the tray's owner before awaiting: `currentAttachmentScope()` in
    // the callback would name whichever pane is open when the prompt settles.
    const scope = currentAttachmentScope();
    const draft = composeDraft();
    const message = attachmentMessage(draft, paths);
    if (fitOperationPrompt(message).truncated) {
      showError(t("compose2.tooLong"));
      return;
    }
    showDraft(message);
    const outcome = await submitAgentPrompt();
    if (outcome === "sent") {
      markAttachmentsSent(scope);
      return;
    }
    // A failure puts the reader's own text back without the paths (they stay
    // in the tray), so a retry cannot carry them twice. A newer draft already
    // in the field is the reader's: never overwrite it. An unknown outcome
    // keeps the controller's cleared field, since the prompt may have arrived.
    if (outcome === "failed" && composeDraft() === message) showDraft(draft);
  }));
}

/** The controller owns draft value/selection; React owns labels and availability. */
export function AgentCompose() {
  const input = useRef<HTMLTextAreaElement>(null);
  // The dock can be mounted twice for a moment while a screen swaps; ids drawn
  // from the instance keep each field's description pointing at its own hint.
  const composeId = useId();
  const statusId = `${composeId}-status`;
  const [limited, setLimited] = useState(false);
  const allowed = canSend();
  const busy = operationBusy();
  // The dock draws the draft and its focus, and folds with the reading
  // posture: a transcript poll or an IME/live publish must not repaint it for
  // fields it does not show.
  const draft = useComposeDraft();
  const focused = useComposeFocused();
  const follow = useChatField((chat) => chat.agentTraceFollow);
  const paneId = usePaneId();
  const selected = useAgentCard(paneId);
  // Return's meaning is a preference the hint line states.
  usePreferenceField((prefs) => prefs.composeEnterSends);
  // Return adds a line only where there is no Shift+Enter: the keyboard decides, not the width.
  const phone = !useHardwareKeyboard();
  const send = useSendKind({ paneId, hasText: Boolean(draft.trim()), live: false, submitting: false });
  const hasMessage = Boolean(draft.trim()) || send.attachments.readyPaths.length > 0;
  const keyboardOpen = useSoftKeyboardOpen();
  const pointer = useDeskPointer();
  const coarse = useCoarsePointer();
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
  // A tablet can gain or lose its mouse mid-session: the frame changes row
  // count under the pointer query, and the field takes its new resting height.
  useLayoutEffect(() => { if (input.current) sizeField(input.current); }, [coarse]);
  const prompt = t(!allowed ? "chat.cantSendPh" : selected?.status === "working" ? "chat.placeholderWorking" : "chat.placeholder");
  // A tablet with a keyboard has no hint line under the field: the field says what Enter does.
  const placeholder = keysInPlace && allowed ? `${prompt} · ${t("deskDock.hintChat")}` : prompt;
  return <div className="dock agent-dock">
    {/* The needs-you card sits in the latest turn; this entry covers a reader scrolled away from it. It
        folds in and out as they scroll, so the transcript's box eases to its new height instead of jumping. */}
    <Fold open={selected?.status === "blocked" && !follow}>
      <div className="agent-confirm">
        <p className="agent-confirm-copy">{t("chat.waitingConfirm")}</p>
        <Button className="btn btn-small" onClick={() => leaveAgentChat()}>{t("needs.go")}</Button>
      </div>
    </Fold>
    <AttachmentTray compact={keyboardOpen} />
    <form className="dock-form agent-compose" onSubmit={event => { event.preventDefault(); void submitAgentMessage(); }}>
      <AttachButton />
      <ComposeFrame field={input} draft={draft} live={false} focused={focused} foldable={phone}
        onResize={() => { if (input.current) sizeField(input.current); }}>
        <textarea ref={input} id={composeId} aria-label={t("chat.composeAria")} aria-describedby={limited ? statusId : undefined}
          rows={1} enterKeyHint={phone ? phoneEnterKeyHint() : "send"} maxLength={OPERATION_INPUT_LIMITS.prompt}
          placeholder={placeholder}
          disabled={!allowed || busy} />
      </ComposeFrame>
      <div className="send-slot">
        <SendIssuePopover attachments={send.attachments} />
        <SendButton
          kind={send.kind === "enter" ? "send" : send.kind}
          percent={send.attachments.pendingPercent}
          className="send-btn"
          compact
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
    <p className="agent-compose-hint" id={statusId} aria-live="polite" hidden={!limited}>{limited ? t("chat.limit") : ""}</p>
  </div>;
}
