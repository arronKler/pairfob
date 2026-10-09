import { CornerDownLeft, Keyboard, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { t } from "../../../lib/i18n";
import { Button, Spinner } from "../../../shared/ui/primitives";
import { useConnection, useRuntime } from "../../connection/hooks";
import { canInterruptAgent } from "../../connection/runtime-status";
import { useDashboard } from "../../dashboard/hooks";
import { agentFromDashboardSnapshot } from "../agents";
import {
  acceptPastedFiles,
  dropBlockedAttachments,
  markAttachmentsSent,
  retryBlockedAttachments,
  sendAttachmentsState,
  subscribeSendAttachments,
  type SendAttachmentsState,
} from "../attachments/attachments-send";
import { PadChromeButton, preventComposeBlurUnlessIME } from "../compose-focus";
import { draftLineCount } from "../compose-size";
import { clearModifiers } from "../keypad/keypad";
import { useShortLandscape } from "../keypad/short-landscape";
import { useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { usePreferences } from "../../settings/hooks";
import { keysExpanded, setKeysExpanded } from "../../settings/preferences-store";
import {
  cancelSendWait,
  connectSendAttachments,
  dismissSendIssue,
  retrySendIssue,
  sendGateSnapshot,
  sendWithoutBlocked,
  subscribeSendGate,
  type SendGateSnapshot,
} from "./send-gate";
import {
  forceStop,
  sendKind,
  startStop,
  stopPhaseFor,
  stopSnapshot,
  subscribeStop,
  type SendKind,
  type StopTarget,
} from "./session-stop";

/**
 * Compose chrome shared by guided, agent chat and full-terminal compose
 * (session page v2): the field frame (live tag, line count, fold on blur) and
 * the send button with its stop / wait / blocked-attachment states. Each
 * surface keeps its own textarea controller and submit path.
 */

/** The settled soft-keyboard state, shared with the keypad (see keypad/soft-keyboard). */
export function useKeyboardOpen(): boolean {
  return useSoftKeyboardOpen();
}

/** Whether Herdr reports this pane as working on a connection that can confirm it. */
export function usePaneWorking(paneId: string): boolean {
  const dashboard = useDashboard();
  useConnection();
  useRuntime();
  const agent = agentFromDashboardSnapshot(dashboard, paneId);
  return canInterruptAgent(agent?.status ?? "");
}

const attachmentsPort = {
  state: sendAttachmentsState,
  subscribe: subscribeSendAttachments,
  markSent: markAttachmentsSent,
  retryBlocked: retryBlockedAttachments,
  dropBlocked: dropBlockedAttachments,
  acceptPaste: acceptPastedFiles,
};

export function useSendAttachments(): SendAttachmentsState {
  return useSyncExternalStore(subscribeSendAttachments, sendAttachmentsState, sendAttachmentsState);
}

export function useSendGate(): SendGateSnapshot {
  return useSyncExternalStore(subscribeSendGate, sendGateSnapshot, sendGateSnapshot);
}

/** The send button's state for one surface; everything it reads is subscribed. */
export function useSendKind({ paneId, hasText, live, submitting }: {
  paneId: string; hasText: boolean; live: boolean; submitting: boolean;
}): { kind: SendKind; attachments: SendAttachmentsState; gate: SendGateSnapshot; working: boolean } {
  const attachments = useSendAttachments();
  const gate = useSendGate();
  // Every compose surface mounts this hook, so the send path has the
  // attachments contract before its first submit (see send-gate).
  useLayoutEffect(() => { connectSendAttachments(attachmentsPort); }, []);
  const stop = useSyncExternalStore(subscribeStop, stopSnapshot, stopSnapshot);
  const working = usePaneWorking(paneId);
  const kind = sendKind({
    hasText,
    ready: attachments.readyPaths.length,
    unfinished: attachments.pending + attachments.blocked,
    submitting,
    waiting: gate.waiting,
    live,
    working,
    stop: stopPhaseFor(stop, paneId),
  });
  return { kind, attachments, gate, working };
}

export const LONG_PRESS_MS = 500;

/**
 * How long a stop button that just replaced a send stays inert. A quick second
 * tap on 发送 must not land on 停止 and interrupt the prompt it just sent.
 */
export const STOP_ARM_MS = 700;

/** False while a freshly swapped-in stop is still arming; true otherwise. */
function useStopArmed(kind: SendKind): boolean {
  const previous = useRef(kind);
  const [armed, setArmed] = useState(true);
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = kind;
    if (kind !== "stop" || from === "stop" || from === "stopping" || from === "force") {
      setArmed(true);
      return;
    }
    setArmed(false);
    const timer = window.setTimeout(() => setArmed(true), STOP_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [kind]);
  return armed || kind !== "stop";
}

/**
 * Pointer handling for the send button: keep compose focus (unless an IME must
 * commit), and a long press runs `onLongPress` and swallows the click that
 * follows it.
 */
function useSendPointer(ref: RefObject<HTMLButtonElement | null>, onLongPress: (() => void) | undefined): void {
  const longPress = useRef(onLongPress);
  longPress.current = onLongPress;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    let fired = false;
    const clear = () => { window.clearTimeout(timer); timer = 0; };
    const down = (event: Event) => {
      preventComposeBlurUnlessIME(event);
      fired = false;
      clear();
      if (!longPress.current) return;
      timer = window.setTimeout(() => {
        timer = 0;
        fired = true;
        longPress.current?.();
      }, LONG_PRESS_MS);
    };
    const click = (event: Event) => {
      if (!fired) return;
      fired = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const menu = (event: Event) => { if (timer || fired) event.preventDefault(); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener("pointerleave", clear);
    el.addEventListener("click", click, true);
    el.addEventListener("contextmenu", menu);
    return () => {
      clear();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", clear);
      el.removeEventListener("pointercancel", clear);
      el.removeEventListener("pointerleave", clear);
      el.removeEventListener("click", click, true);
      el.removeEventListener("contextmenu", menu);
    };
  }, [ref]);
}

export type SendButtonProps = {
  kind: SendKind;
  /** Mean upload progress while waiting. */
  percent: number;
  className: string;
  /** enter / send: the surface's submit (a form submit when `submitsForm`). */
  onSend: () => void;
  submitsForm?: boolean;
  stopTarget: StopTarget | null;
  /** Long press stops while the pane works and the button is a send button. */
  longPressStops: boolean;
  disabled?: boolean;
};

function sendContent(kind: SendKind, percent: number): { label: ReactNode; aria: string } {
  switch (kind) {
    case "enter":
      return { label: <CornerDownLeft size={19} aria-hidden="true" />, aria: t("compose.enterAria") };
    case "send":
      return { label: t("compose.send"), aria: t("compose.sendEnterAria") };
    case "busy":
      return { label: t("compose.sending"), aria: t("compose.sendingAria") };
    case "wait":
      return { label: <><Spinner />{t("compose2.waitUpload", { n: percent })}</>, aria: t("compose2.waitUploadAria") };
    case "stop":
      return { label: <><Square size={13} fill="currentColor" aria-hidden="true" />{t("compose2.stop")}</>, aria: t("compose2.stopAria") };
    case "stopping":
      return { label: <><Spinner />{t("compose2.stopping")}</>, aria: t("compose2.stoppingAria") };
    case "force":
      return { label: <><Square size={13} fill="currentColor" aria-hidden="true" />{t("compose2.force")}</>, aria: t("compose2.forceAria") };
  }
}

/** One button, bottom-aligned in every state, whose meaning follows `sendKind`. */
export function SendButton({ kind, percent, className, onSend, submitsForm = false, stopTarget, longPressStops, disabled = false }: SendButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useSendPointer(ref, longPressStops && kind === "send" && stopTarget ? () => startStop(stopTarget) : undefined);
  const { label, aria } = sendContent(kind, percent);
  // A stop still arming keeps its look (no grey flash) and only ignores taps.
  const armed = useStopArmed(kind);
  const inert = kind === "busy" || kind === "stopping";
  const submits = submitsForm && (kind === "send" || kind === "enter");
  return <Button
    ref={ref}
    type={submits ? "submit" : "button"}
    className={`${className} send-kind-${kind}`}
    data-send-kind={kind}
    disabled={disabled || inert}
    aria-busy={inert || kind === "wait" ? "true" : undefined}
    aria-disabled={armed ? undefined : true}
    aria-label={aria}
    onClick={submits ? undefined : (event) => {
      // The click re-renders this button (cancelling a wait turns it back into a
      // submit button) before the browser runs its default action; without this
      // the same tap would submit the form and start waiting again.
      event.preventDefault();
      if (kind === "wait") cancelSendWait();
      else if (kind === "stop" && stopTarget) { if (armed) startStop(stopTarget); }
      else if (kind === "force") forceStop();
      else if (kind === "send" || kind === "enter") onSend();
    }}
  >{label}</Button>;
}

/** Above the send button: blocked attachments need a choice before the message goes. */
export function SendIssuePopover({ attachments }: { attachments: SendAttachmentsState }) {
  const gate = useSendGate();
  if (!gate.issue) return null;
  const p2p = attachments.waitingP2P;
  return <div className="send-issue" role="alertdialog" aria-labelledby="send-issue-title">
    <b id="send-issue-title">{p2p ? t("compose2.issueP2P") : t("compose2.issueBlocked", { n: attachments.blocked })}</b>
    {attachments.blockedNames.length > 0 && <small className="send-issue-names">{attachments.blockedNames.join("、")}</small>}
    <div className="send-issue-actions">
      <Button className="send-issue-primary" onClick={retrySendIssue}>
        {p2p ? t("compose2.issueConnect") : t("compose2.issueRetry")}
      </Button>
      <Button className="send-issue-skip" onClick={() => void sendWithoutBlocked()}>{t("compose2.issueSkip")}</Button>
      <Button className="send-issue-close" aria-label={t("compose2.issueDismiss")} onClick={dismissSendIssue}>×</Button>
    </div>
  </div>;
}

export type ComposeFrameProps = {
  field: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  live: boolean;
  focused: boolean;
  /** Phone layouts give a multi-line draft's space back to the terminal on blur. */
  foldable: boolean;
  /** Re-measure after the fold changes the field's height. */
  onResize?: () => void;
  children: ReactNode;
};

/**
 * The frame around a compose textarea: green border and "实时" tag in live
 * mode, a faint "N 行" past three lines, and the folded state. A folded field
 * is covered by a button so the tap that expands it restores the caret where
 * the reader left it, instead of wherever the finger landed.
 */
export function ComposeFrame({ field, draft, live, focused, foldable, onResize, children }: ComposeFrameProps) {
  const lines = draftLineCount(draft);
  const folded = foldable && !focused && !live && lines > 1;
  const caret = useRef<[number, number] | null>(null);
  const resize = useRef(onResize);
  resize.current = onResize;
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    // Where the reader left the caret, for the tap that unfolds the field.
    const save = () => { caret.current = [el.selectionStart, el.selectionEnd]; };
    el.addEventListener("blur", save);
    return () => el.removeEventListener("blur", save);
  }, [field]);
  // Folding, and the keyboard changing the room the field may take, both re-measure.
  // So do the pad opening over a phone on its side, where its rows come out of
  // the lines the field may show, and the phone being turned.
  const keyboardOpen = useKeyboardOpen();
  const padOpen = usePreferences().keysExpanded;
  const landscape = useShortLandscape();
  useLayoutEffect(() => { resize.current?.(); }, [folded, keyboardOpen, padOpen, landscape]);
  const showLines = !live && (lines > 3 || folded);
  const unfold = () => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const [start, end] = caret.current ?? [el.value.length, el.value.length];
    el.setSelectionRange(start, end);
  };
  return <div className={`compose-field${live ? " is-live" : ""}${folded ? " is-folded" : ""}`}>
    {live && <span className="compose-live-tag" aria-hidden="true">{t("compose2.liveTag")}</span>}
    {children}
    {showLines && <span className="compose-lines" aria-hidden="true">{t("compose2.lines", { n: lines })}</span>}
    {folded && <Button className="compose-unfold" aria-label={t("compose2.unfoldAria", { n: lines })} onClick={unfold} />}
  </div>;
}

/**
 * "按键" in the dock of a mouse-driven session. A hardware keyboard has every
 * key the pad offers, so the pad is put away until asked for; this shows and
 * hides the same expanded pad the touch row's ⋯ opens.
 */
export function DockKeysButton() {
  const expanded = usePreferences().keysExpanded;
  return <PadChromeButton type="button" className="dock-keys-btn" aria-expanded={expanded ? "true" : "false"}
    title={t(expanded ? "deskDock.keysHide" : "deskDock.keysShow")}
    onClick={() => {
      clearModifiers();
      setKeysExpanded(!keysExpanded());
    }}>
    <Keyboard size={16} aria-hidden="true" /><span>{t("deskDock.keys")}</span>
  </PadChromeButton>;
}

/**
 * 组字 / 实时 under the field of a mouse-driven session: the per-pane input mode
 * the `···` panel also sets, with a line saying where the keys go. The field
 * itself still carries the live marking; this only makes the choice reachable.
 */
export function InputModeSwitch({ live, onChange, hints }: {
  live: boolean; onChange: (live: boolean) => void; hints: readonly string[];
}) {
  return <div className="dock-mode">
    <div className="dock-mode-switch" role="group" aria-label={t("pane.inputAria")}>
      {[false, true].map(option => <PadChromeButton key={String(option)} type="button" className="dock-mode-option"
        aria-pressed={live === option ? "true" : "false"} title={t(option ? "pane.liveAria" : "pane.composeAria")}
        onClick={() => { if (live !== option) onChange(option); }}>
        {t(option ? "compose.live" : "compose.batch")}</PadChromeButton>)}
    </div>
    <p className="dock-mode-hint">{hints.map(hint => <span key={hint}>{hint}</span>)}</p>
  </div>;
}
