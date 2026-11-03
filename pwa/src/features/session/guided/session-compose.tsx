import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { t } from "../../../lib/i18n";
import { OPERATION_INPUT_LIMITS } from "../../../lib/operations";
import {
  bindTermField,
  composeViewSnapshot,
  focusCompose,
  liveInputPreview,
  setComposeLive,
  sizeCompose,
  submitTyped,
  subscribeComposeView,
} from "./compose";
import { AttachButton } from "../attachments/attach-button";
import { phoneEnterKeyHint } from "../compose-keys";
import { useDeskPointer, useKeyboardHintsInPlace } from "../desk-pointer";
import { useComposeDraft, useComposeFocused, useComposeLive, usePaneId } from "../hooks";
import { usePreferenceField } from "../../settings/hooks";
import { queueKey } from "./keys";
import {
  ComposeFrame,
  DockKeysButton,
  FieldModeSwitch,
  SendButton,
  SendIssuePopover,
  useSendKind,
} from "./compose-controls";
import { cancelStop, type StopTarget } from "./session-stop";
import { resetSendGate } from "./send-gate";

export type SessionComposeProps = {
  /** The session header carries a back control. Standalone, that also means the phone field. */
  includeBack: boolean;
  /**
   * No hardware keyboard: Return adds a line and a blurred draft folds (ids
   * `compose-text-mobile` vs `compose-text-desktop`). The pane passes what the
   * device can do; a wide layout can be a touch tablet and a back button can sit
   * beside a mouse.
   */
  phone?: boolean;
};

/** Guided compose field. The textarea is controller-owned after mount; React only owns chrome. */
export function SessionCompose({ includeBack, phone = includeBack }: SessionComposeProps) {
  const snap = useSyncExternalStore(subscribeComposeView, composeViewSnapshot, composeViewSnapshot);
  const live = useComposeLive();
  const paneId = usePaneId();
  const focused = useComposeFocused();
  // The button's face and the line count follow the text; a controller-owned
  // field publishes it here, and the view snapshot alone does not see a keystroke.
  useComposeDraft();
  const pointer = useDeskPointer();
  // A tablet with a keyboard has no hint line under the field: the field says it.
  const keysInPlace = useKeyboardHintsInPlace();
  // Return's meaning is a preference the hint line states; the domain's other
  // fields (the draft, a tap timestamp) must not repaint the field.
  usePreferenceField((prefs) => prefs.composeEnterSends);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputID = phone ? "compose-text-mobile" : "compose-text-desktop";
  const statusID = `${inputID}-live-status`;
  const pending = live && Boolean(snap.pendingText);
  const aria = live ? t("compose.liveAria") : t("compose.batchAria");
  const placeholder = pending
    ? t("compose.pendingPh", { text: liveInputPreview(snap.pendingText) })
    // "Tap Send" is for a field whose Return adds a line. Where Enter sends,
    // the neutral one reads true: the same fact decides both.
    : live ? (keysInPlace ? t("deskDock.liveKeysPh") : t("compose.livePh"))
      : phone ? t("compose.batchPh") : keysInPlace ? t("deskDock.batchKeysPh") : t("deskDock.batchPh");
  const send = useSendKind({
    paneId,
    hasText: !live && Boolean(snap.draft.trim()),
    // In live input the button is the Enter key glass does not have. A mouse
    // comes with a keyboard that has one, so there it stays free to stop the
    // agent while it works, as it does in 组字.
    live: live && !pointer,
    submitting: snap.submitBusy && !live,
  });
  const stopTarget = useMemo<StopTarget | null>(
    () => paneId ? { paneId, sendKey: (key) => queueKey(key) } : null,
    [paneId],
  );

  // Bound once: the field outlives a change of `phone` (a first hardware key
  // on a tablet), and its Return rule reads the id at the key, so the draft and
  // the caret are never rewritten under the reader.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    return bindTermField(input);
  }, []);

  // The echo a live field waits for wraps where a hint would not: the field
  // grows by its lines and returns to one when the terminal has caught up.
  useLayoutEffect(() => {
    if (live && inputRef.current) sizeCompose(inputRef.current);
  }, [live, placeholder]);

  // A pending send or stop belongs to this pane's dock; neither may fire after it leaves.
  useLayoutEffect(() => () => { resetSendGate(); cancelStop(); }, [paneId]);

  return <form
    className={`dock-form${live ? " live" : ""}${pending ? " live-pending" : ""}`}
    onSubmit={(event) => {
      event.preventDefault();
      void submitTyped(true);
    }}
  >
    <label className="sr-only" htmlFor={inputID}>{aria}</label>
    <span className="sr-only live-input-status" id={statusID} role="status" aria-live="polite">
      {pending ? t("compose.pendingStatus", { n: Array.from(snap.pendingText).length }) : ""}
    </span>
    <AttachButton />
    <ComposeFrame field={inputRef} draft={live ? "" : snap.draft} live={live} focused={focused}
      foldable={phone}
      modeSwitch={pointer ? <FieldModeSwitch live={live} onChange={(next) => {
        void setComposeLive(next);
        focusCompose();
      }} /> : undefined}
      onResize={() => { if (inputRef.current) sizeCompose(inputRef.current); }}>
      <textarea
        ref={inputRef}
        id={inputID}
        name="pairfob-compose"
        rows={1}
        wrap="soft"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="text"
        aria-label={aria}
        aria-describedby={statusID}
        placeholder={placeholder}
        enterKeyHint={phone && !live ? phoneEnterKeyHint() : "enter"}
        maxLength={OPERATION_INPUT_LIMITS.prompt}
      />
    </ComposeFrame>
    <DockKeysButton />
    <div className="send-slot">
      <SendIssuePopover attachments={send.attachments} />
      <SendButton
        kind={send.kind}
        percent={send.attachments.pendingPercent}
        className="send-btn"
        submitsForm
        onSend={() => void submitTyped(true)}
        stopTarget={stopTarget}
        longPressStops={send.working && !live}
      />
    </div>
  </form>;
}
