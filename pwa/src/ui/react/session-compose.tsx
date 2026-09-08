import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { OPERATION_INPUT_LIMITS } from "../../lib/operations";
import {
  bindTermField,
  composeViewSnapshot,
  liveInputPreview,
  submitTyped,
  subscribeComposeView,
} from "../session/compose";
import { preventComposeBlurUnlessIME, usePointerDown } from "./keep-compose-focus";

export type SessionComposeProps = {
  /** True on the phone session dock: ids `compose-text-mobile` vs `compose-text-desktop`. */
  includeBack: boolean;
};

/** Guided compose field. The textarea is controller-owned after mount; React only owns chrome. */
export function SessionCompose({ includeBack }: SessionComposeProps) {
  const snap = useSyncExternalStore(subscribeComposeView, composeViewSnapshot, composeViewSnapshot);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = usePointerDown(preventComposeBlurUnlessIME);
  const inputID = includeBack ? "compose-text-mobile" : "compose-text-desktop";
  const statusID = `${inputID}-live-status`;
  const pending = snap.live && Boolean(snap.pendingText);
  const aria = snap.live ? t("compose.liveAria") : t("compose.batchAria");
  const placeholder = pending
    ? t("compose.pendingPh", { text: liveInputPreview(snap.pendingText) })
    : snap.live ? t("compose.livePh") : t("compose.batchPh");
  const sending = snap.submitBusy && !snap.live;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    return bindTermField(input);
  }, [inputID]);

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
      enterKeyHint="enter"
      maxLength={OPERATION_INPUT_LIMITS.prompt}
    />
    <button
      ref={sendRef}
      type="submit"
      className="send-btn"
      disabled={sending}
      aria-busy={sending ? "true" : undefined}
      aria-label={sending ? t("compose.sendingAria") : snap.draft.trim() ? t("compose.sendEnterAria") : t("compose.enterAria")}
    >{sending ? t("compose.sending") : "Enter"}</button>
  </form>;
}
