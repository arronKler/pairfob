import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { t } from "../../../lib/i18n";
import { OPERATION_INPUT_LIMITS } from "../../../lib/operations";
import {
  bindTermField,
  composeViewSnapshot,
  liveInputPreview,
  sizeCompose,
  submitTyped,
  subscribeComposeView,
} from "./compose";
import { AttachButton } from "../attachments/attach-button";
import { phoneEnterKeyHint } from "../compose-keys";
import { useDeskPointer, useKeyboardHintsInPlace } from "../desk-pointer";
import { useCompose, useSession } from "../hooks";
import { usePreferences } from "../../settings/hooks";
import { queueKey } from "./keys";
import { ComposeFrame, DockKeysButton, SendButton, SendIssuePopover, useSendKind } from "./compose-controls";
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
  /** A mouse-driven dock keeps its key pad behind a "按键" button beside the field. */
  keysButton?: boolean;
};

/** Guided compose field. The textarea is controller-owned after mount; React only owns chrome. */
export function SessionCompose({ includeBack, phone = includeBack, keysButton = false }: SessionComposeProps) {
  const snap = useSyncExternalStore(subscribeComposeView, composeViewSnapshot, composeViewSnapshot);
  const paneId = useSession().paneId;
  const focused = useCompose().composeFocused;
  const pointer = useDeskPointer();
  // A tablet with a keyboard has no hint line under the field: the field says it.
  const keysInPlace = useKeyboardHintsInPlace();
  usePreferences();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputID = phone ? "compose-text-mobile" : "compose-text-desktop";
  const statusID = `${inputID}-live-status`;
  const pending = snap.live && Boolean(snap.pendingText);
  const aria = snap.live ? t("compose.liveAria") : t("compose.batchAria");
  const placeholder = pending
    ? t("compose.pendingPh", { text: liveInputPreview(snap.pendingText) })
    // "Tap Send" is for a field whose Return adds a line. Where Enter sends,
    // the neutral one reads true: the same fact decides both.
    : snap.live ? (keysInPlace ? t("deskDock.liveKeysPh") : t("compose.livePh"))
      : phone ? t("compose.batchPh") : keysInPlace ? t("deskDock.batchKeysPh") : t("deskDock.batchPh");
  const send = useSendKind({
    paneId,
    hasText: !snap.live && Boolean(snap.draft.trim()),
    // In live input the button is the Enter key glass does not have. A mouse
    // comes with a keyboard that has one, so there it stays free to stop the
    // agent while it works, as it does in 组字.
    live: snap.live && !pointer,
    submitting: snap.submitBusy && !snap.live,
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
    if (snap.live && inputRef.current) sizeCompose(inputRef.current);
  }, [snap.live, placeholder]);

  // A pending send or stop belongs to this pane's dock; neither may fire after it leaves.
  useLayoutEffect(() => () => { resetSendGate(); cancelStop(); }, [paneId]);

  return <form
    className={`dock-form${snap.live ? " live" : ""}${pending ? " live-pending" : ""}`}
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
    <ComposeFrame field={inputRef} draft={snap.live ? "" : snap.draft} live={snap.live} focused={focused}
      foldable={phone} onResize={() => { if (inputRef.current) sizeCompose(inputRef.current); }}>
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
        enterKeyHint={phone && !snap.live ? phoneEnterKeyHint() : "enter"}
        maxLength={OPERATION_INPUT_LIMITS.prompt}
      />
    </ComposeFrame>
    {keysButton && <DockKeysButton />}
    <div className="send-slot">
      <SendIssuePopover attachments={send.attachments} />
      <SendButton
        kind={send.kind}
        percent={send.attachments.pendingPercent}
        className="send-btn"
        submitsForm
        onSend={() => void submitTyped(true)}
        stopTarget={stopTarget}
        longPressStops={send.working && !snap.live}
      />
    </div>
  </form>;
}
