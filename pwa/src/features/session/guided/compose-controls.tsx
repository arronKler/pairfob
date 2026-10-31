import { CornerDownLeft, Keyboard, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { t } from "../../../lib/i18n";
import { MOTION_MS } from "../../../shared/ui/dom/motion";
import { Button, Spinner, Swap } from "../../../shared/ui/primitives";
import { useConnectionContact, useRuntime } from "../../connection/hooks";
import { canInterruptAgent } from "../../connection/runtime-status";
import { useAgentCard } from "../hooks";
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
import { playMove } from "../measured-move";
import { clearModifiers } from "../keypad/keypad";
import { useShortLandscape } from "../keypad/short-landscape";
import { useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { useKeysExpanded } from "../../settings/hooks";
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
  const agent = useAgentCard(paneId);
  useConnectionContact();
  useRuntime();
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
 * tap on 发送 must not land on 停止 and interrupt the prompt it just sent, and a
 * tap aimed at the button must not find it changed under the finger.
 */
export const STOP_ARM_MS = 700;

/**
 * A swap this soon after the reader's own action is that action's doing: they
 * deleted the draft, or took the last attachment out of the tray, and saw 停止
 * take the slot, so the tap that follows is meant for it. The stores publish
 * inside the event, well inside this window. An edit that leaves text behind
 * does not count, and neither does a press on the button itself: the swap
 * after those is a send.
 */
const OWN_ACTION_MS = 150;

/** False while a freshly swapped-in stop is still arming; true otherwise. */
function useStopArmed(kind: SendKind, button: RefObject<HTMLButtonElement | null>): boolean {
  const previous = useRef(kind);
  const actedAt = useRef(Number.NEGATIVE_INFINITY);
  const [armed, setArmed] = useState(true);
  useLayoutEffect(() => {
    // Capture on the document runs before the control's own listener changes the message.
    const edited = (event: Event) => {
      const field = event.target;
      const emptied = (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && !field.value.trim();
      actedAt.current = emptied ? performance.now() : Number.NEGATIVE_INFINITY;
    };
    const pressed = (event: Event) => {
      if (event.target instanceof Node && button.current?.contains(event.target)) return;
      actedAt.current = performance.now();
    };
    document.addEventListener("input", edited, true);
    document.addEventListener("compositionend", edited, true);
    document.addEventListener("click", pressed, true);
    return () => {
      document.removeEventListener("input", edited, true);
      document.removeEventListener("compositionend", edited, true);
      document.removeEventListener("click", pressed, true);
    };
  }, [button]);
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = kind;
    const ownAction = performance.now() - actedAt.current < OWN_ACTION_MS;
    if (kind !== "stop" || from === "stop" || from === "stopping" || from === "force" || ownAction) {
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

/**
 * A change of kind changes the label, and with it the button's width: the
 * field beside it gave way in one frame. The button eases from the width it had
 * to the width its new label needs, and the field follows.
 *
 * Not in the complete terminal. There the field would be laid out again on
 * every frame of the move over a box whose height is the computer's rows; its
 * button changes width at once, as it did, and a stop under way holds one
 * width for its steps (`.send-reserve`).
 *
 * The box it starts from is the observer's to keep: a size the browser already
 * reported needs no second read, and reading it on every commit would lay the
 * page out again after every keystroke and every terminal patch, for a box that
 * did not move. The observer also follows the changes that are not this
 * control's own — a language switch, another width tier — where the same face
 * gets a new width without a commit of its own.
 */
function useEasedWidth(ref: RefObject<HTMLButtonElement | null>, kind: SendKind): void {
  const shown = useRef(kind);
  const width = useRef<number | null>(null);
  const move = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The box as it stands at mount: the first move starts from here even
    // before the observer has reported anything.
    width.current = el.getBoundingClientRect().width;
    const Observer = el.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    // The size is read off the entry, not the element: measuring here would lay
    // the page out again inside a resize pass. A move's own frames are welcome
    // here: a move under way starts from where the box is, not from this, and
    // the last frame leaves it on the width the move ended at.
    const observer = new Observer((entries) => {
      const entry = entries.at(-1);
      const box = entry?.borderBoxSize;
      const size = (Array.isArray(box) ? box[0] : box)?.inlineSize;
      width.current = size ?? entry?.contentRect.width ?? null;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || shown.current === kind) return;
    shown.current = kind;
    // Mid-move the box is still on its way; the next move starts from where it is.
    const from = move.current?.playState === "running" ? el.getBoundingClientRect().width : width.current;
    move.current?.cancel();
    move.current = null;
    const to = el.getBoundingClientRect().width;
    width.current = to;
    if (from === null || Math.abs(from - to) < 1 || el.closest(".full-terminal-pad")) return;
    // Clipped on the way: a longer label does not hang out of a box still growing to it.
    move.current = playMove(el, [{ width: `${from}px`, overflow: "hidden" }, { width: `${to}px`, overflow: "hidden" }], MOTION_MS.element);
  }, [kind]);
  useLayoutEffect(() => () => { move.current?.cancel(); }, []);
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

/**
 * One button, bottom-aligned in every state, whose meaning follows `sendKind`.
 * A change of kind is one move: the colours cross over, the label fades in
 * (`Swap`, which is still when the same kind is drawn again) and the width
 * eases (`useEasedWidth`).
 */
export function SendButton({ kind, percent, className, onSend, submitsForm = false, stopTarget, longPressStops, disabled = false }: SendButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useSendPointer(ref, longPressStops && kind === "send" && stopTarget ? () => startStop(stopTarget) : undefined);
  useEasedWidth(ref, kind);
  const { label, aria } = sendContent(kind, percent);
  // A stop still arming keeps its look (no grey flash) and only ignores taps.
  const armed = useStopArmed(kind, ref);
  // Once a stop is under way the button already has the width of its widest
  // step, 强制停止: it does not grow under the finger when that step is offered.
  // One wrapper in every kind, so the label is the same node's child throughout
  // and knows a change of kind from a first paint.
  const reserve = kind === "stopping" || kind === "force";
  const content = <span className={reserve ? "send-face send-reserve" : "send-face"} data-widest={reserve ? t("compose2.force") : undefined}>
    <Swap on={kind} className="send-label">{label}</Swap>
  </span>;
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
  >{content}</Button>;
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
  const padOpen = useKeysExpanded();
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
  const expanded = useKeysExpanded();
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
