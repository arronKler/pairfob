import { flushSync } from "react-dom";
import { ChevronDown, Ellipsis } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { composeFocused, composeIME, composeLive } from "../compose-store";
import { sessionMayTakeFocus } from "../focus";
import { useComposeLive, usePaneId } from "../hooks";
import { useKeysExpanded } from "../../settings/hooks";
import { keysExpanded, setKeysExpanded } from "../../settings/preferences-store";
import { t } from "../../../lib/i18n";
import {
  type FullTerminalControlsOptions,
  requestFullTerminalPadEnter,
  insertFullTerminalQuickCommand,
  insertFullTerminalSlashCommand,
  sendFullTerminalAttachments,
  setFullTerminalInputMode,
} from "./full-terminal-compose";
import {
  fullTerminalKeyboardOpen,
  notifyFullTerminalKeyboard,
  subscribeFullTerminalKeyboard,
} from "./full-terminal-input";
import { useModifierScope } from "../keypad/modifier-scope";
import {
  PRIMARY_KEYS,
  PAGE_KEYS,
  EXPANDED_KEYS,
  EXTRA_KEYS,
  clearModifiers,
  modifierSnapshot,
  subscribeModifiers,
  withModifiers,
  type KeySpec,
} from "../keypad/keypad";
import { PadKey } from "../keypad/pad-key";
import { useShortLandscape } from "../keypad/short-landscape";
import { dismissSoftKeyboard, useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { FullTerminalCompose } from "./full-terminal-compose-field";
import { bindFullTerminalDeskKeys } from "./full-terminal-desk-keys";
import { useFullTerminalStopTarget } from "./full-terminal-stop";
import { AttachButton } from "../attachments/attach-button";
import { AttachmentTray } from "../attachments/attachment-tray";
import {
  DockKeysButton,
  InputModeSwitch,
  SendButton,
  SendIssuePopover,
  useSendKind,
} from "../guided/compose-controls";
import { cancelStop } from "../guided/session-stop";
import { usePointerFine } from "../../../app/input-mode";
import { useDeskPointer, useKeyboardHintsInPlace } from "../desk-pointer";
import { PadChromeButton } from "../compose-focus";
import { SessionSlashPad } from "../guided/session-slash-pad";

function FullTerminalKeyButton({ spec, onKey }: { spec: KeySpec; onKey: (key: string, el: HTMLElement) => void }) {
  return <PadKey spec={spec} onPress={(el) => {
    for (const key of withModifiers(spec.key)) onKey(key, el);
  }} />;
}

/**
 * Where a live terminal's keys go, drawn where the compose field would be and
 * worded as the guided session's live field is: one mode, one name for it. The
 * terminal already has the keyboard; pressing this hands it the caret after a
 * click elsewhere took it. Under a finger the same press puts the keyboard away
 * again, so the row needs no button of its own for that.
 *
 * Focus happens inside the completed click: on pointerdown it would race the
 * tap's own default focus handling and iOS keyboard updates. `PadChromeButton`
 * keeps the press from moving focus before that click arrives.
 */
function FullTerminalLiveField({ onToggle, toggleable, label }: {
  onToggle: () => void;
  /** No mouse: the press is a keyboard toggle, not only a hand-off. */
  toggleable: boolean;
  label: string;
}) {
  const open = useSyncExternalStore(subscribeFullTerminalKeyboard, fullTerminalKeyboardOpen, fullTerminalKeyboardOpen);
  return <div className="compose-field is-live full-terminal-live-field">
    <span className="compose-live-tag" aria-hidden="true">{t("compose2.liveTag")}</span>
    <PadChromeButton
      type="button"
      className="full-terminal-live-focus"
      aria-label={toggleable ? t(open ? "ft.kbHide" : "ft.kbOpen") : t("deskDock.liveFieldAria")}
      aria-pressed={toggleable ? (open ? "true" : "false") : undefined}
      onClick={onToggle}
    ><span className="full-terminal-live-label">{label}</span></PadChromeButton>
  </div>;
}

/**
 * The live terminal's dock row, shaped like the guided live field's: attach,
 * the field that hands over the keyboard, 按键 for a mouse, and one trailing
 * action. That action is the guided button too: Enter, send attachments, or
 * stop while the agent works under a mouse.
 */
function FullTerminalLiveRow({ optionsRef, pointer }: {
  optionsRef: { current: FullTerminalControlsOptions };
  pointer: boolean;
}) {
  const paneId = usePaneId();
  const keysInPlace = useKeyboardHintsInPlace();
  const sendRef = useRef(optionsRef.current.sendCompose);
  sendRef.current = optionsRef.current.sendCompose;
  // The keyboard is toggled by a finger's field, never by a mouse's, whatever
  // the window width (a narrow laptop window is a phone layout with a mouse).
  const toggleable = !usePointerFine();
  // The guided rule for the trailing button: a mouse-driven desk may stop,
  // a finger's live field is the Enter key and never becomes 停止.
  const sendState = useSendKind({ paneId, hasText: false, live: !pointer, submitting: false });
  const stopTarget = useFullTerminalStopTarget(paneId, sendRef);
  // A pending stop belongs to this pane's dock; it may not fire after it leaves.
  useLayoutEffect(() => () => { cancelStop(); }, [paneId]);

  return <div className="full-terminal-compose-form full-terminal-live-actions">
    <AttachButton />
    <FullTerminalLiveField
      toggleable={toggleable}
      label={keysInPlace ? t("deskDock.liveKeysPh") : t("compose.livePh")}
      onToggle={() => {
        const keyboard = optionsRef.current.keyboard;
        if (toggleable && keyboard.isOpen()) keyboard.close();
        else keyboard.open();
        // The controller also publishes this; a keyboard handed in without an
        // emitter (tests, a standalone binding) still updates the field.
        notifyFullTerminalKeyboard(keyboard.isOpen());
      }}
    />
    {pointer && <DockKeysButton />}
    <div className="send-slot">
      <SendIssuePopover attachments={sendState.attachments} />
      <SendButton
        kind={sendState.kind}
        percent={sendState.attachments.pendingPercent}
        className="full-terminal-compose-send"
        onSend={() => {
          if (sendState.kind === "send") sendFullTerminalAttachments(optionsRef.current.sendCompose, () => undefined);
          // Live typing sends its own keys; this is the deliberate Enter.
          else optionsRef.current.sendCompose("", true);
        }}
        stopTarget={stopTarget}
        longPressStops={false}
      />
    </div>
  </div>;
}

function FullTerminalPadControls({
  optionsRef,
  padRef,
  collapsible,
  dense,
  onPage,
}: {
  optionsRef: { current: FullTerminalControlsOptions };
  padRef: { current: HTMLDivElement | null };
  /** The mouse-driven pad: shown only while expanded, with paging in its first row. */
  collapsible: boolean;
  /** A phone on its side: one row of keys to a page. */
  dense: boolean;
  onPage?: (direction: "up" | "down") => void;
}) {
  useModifierScope();
  useSyncExternalStore(subscribeModifiers, modifierSnapshot, modifierSnapshot);
  const [, bump] = useState(0);
  const restoreCompose = (): void => {
    const field = padRef.current?.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input");
    if (field && (composeFocused() || composeIME())) field.focus({ preventScroll: true });
  };
  const repaint = () => {
    bump((n) => n + 1);
    restoreCompose();
  };
  const expanded = useKeysExpanded();

  const onKey = (key: string, _el: HTMLElement): void => {
    if (!composeLive() && key === "enter") {
      const pad = padRef.current;
      if (pad) requestFullTerminalPadEnter(pad);
      return;
    }
    optionsRef.current.sendKey(key);
  };

  const selectCommand = (text: string): void => {
    const pad = padRef.current;
    if (pad) insertFullTerminalSlashCommand(pad, text, optionsRef.current.sendCompose);
  };

  // Same exclusivity as the guided pad: the soft keyboard (or the live
  // terminal's own keyboard) and the expanded pad are never on screen together.
  const keyboard = useSoftKeyboardOpen();
  const shown = expanded && !keyboard;
  if (collapsible && !shown) return null;

  // The pad a mouse calls up is momentary: the terminal keeps its rows under it (see `terminalRoom`).
  return <div className={collapsible ? "full-terminal-pad-controls is-momentary" : "full-terminal-pad-controls"}>
    <div className={collapsible ? "keys keys-paged" : "keys"} role="group" aria-label={t("keys.primary")}>
      {PRIMARY_KEYS.map((spec) => <FullTerminalKeyButton key={spec.key} spec={spec} onKey={onKey} />)}
      {collapsible && onPage && PAGE_KEYS.map((spec) => <PadKey key={spec.key} spec={spec}
        onPress={() => onPage(spec.key === "pageup" ? "up" : "down")} />)}
      <PadChromeButton
        type="button"
        className="key key-more"
        aria-label={t("keys.morePad")}
        aria-expanded={shown ? "true" : "false"}
        onClick={() => {
          clearModifiers();
          if (keyboard) {
            const control = optionsRef.current.keyboard;
            if (control.isOpen()) {
              control.close();
              notifyFullTerminalKeyboard(false);
            }
            // No repaint here: it would put focus straight back in the field.
            dismissSoftKeyboard();
            setKeysExpanded(true);
            return;
          }
          setKeysExpanded(!keysExpanded());
          repaint();
        }}
      >{shown ? <ChevronDown size={20} aria-hidden="true" /> : <Ellipsis size={20} aria-hidden="true" />}</PadChromeButton>
    </div>
    {shown && <SessionSlashPad rows={dense ? 1 : 2} onSelect={selectCommand} onCustomSelect={(text) => {
      // A saved command can span lines, so it lands in the batch field (at the
      // caret) rather than being typed live, where each newline would be Enter.
      flushSync(() => {
        setFullTerminalInputMode(false, optionsRef.current.sendCompose, repaint);
      });
      if (padRef.current) insertFullTerminalQuickCommand(padRef.current, text);
    }} keyItems={[...EXPANDED_KEYS, ...EXTRA_KEYS]
      .map((spec) => <FullTerminalKeyButton key={spec.key} spec={spec} onKey={onKey} />)} />}
  </div>;
}

export type FullTerminalPadProps = {
  options: FullTerminalControlsOptions;
  /** Page the remote terminal; the mouse-driven pad offers it in place of the hidden scroll rail. */
  onPage?: (direction: "up" | "down") => void;
};

/**
 * Complete-terminal pad + compose.
 * Keys go through `options.sendKey` (withModifiers), never the guided session key queue.
 * The compose row is a sibling of the controls so expand/slash morphs do not
 * remount the field. Keep `options` callbacks stable across chrome updates.
 *
 * 组字 and 实时 share the guided dock's one row: attach, the field, and one
 * trailing action. In live input the field hands the keyboard to xterm (and
 * puts it away again under a finger), and that action is Enter, send
 * attachments, or stop while the agent works under a mouse.
 *
 * Driven by a mouse beside the list, the keys wait behind "按键" and the
 * 组字 / 实时 switch sits under the field. On a phone turned on its side the
 * finger's pad is dense (`is-dense`): one row of keys to a page.
 */
export function FullTerminalPad({ options, onPage }: FullTerminalPadProps) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const padRef = useRef<HTMLDivElement>(null);
  // The pad draws the live/batch switch and nothing else of the field: a
  // keystroke or a focus change must not repaint the whole key grid.
  const live = useComposeLive();
  const keyboardOpen = useSoftKeyboardOpen();
  const hardware = options.hardwareKeyboard;
  const pointer = useDeskPointer();
  const dense = useShortLandscape() && !pointer;

  const wasLive = useRef(false);
  useLayoutEffect(() => {
    const keyboard = optionsRef.current.keyboard;
    if (composeLive()) {
      // The keys are xterm's from here, and on the switch to 实时 so is the caret,
      // where the session may take it. A keyboard that only now proved itself (a
      // tablet's first key, typed anywhere, a note in the inspector included)
      // moves no caret: that key goes where it was pressed, and focus follows it.
      if (hardware) keyboard.open(!wasLive.current && sessionMayTakeFocus());
    } else {
      keyboard.close();
    }
    wasLive.current = composeLive();
    notifyFullTerminalKeyboard(keyboard.isOpen());
  }, [live, hardware]);

  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  useLayoutEffect(() => {
    if (!padRef.current) return;
    return bindFullTerminalDeskKeys(padRef.current, {
      page: (direction) => onPageRef.current?.(direction),
      // A modifier armed on the key row applies to a typed key as it does to a pressed one.
      send: (key) => { for (const mapped of withModifiers(key)) optionsRef.current.sendKey(mapped); },
      focus: () => optionsRef.current.keyboard.open(),
      copySelection: () => optionsRef.current.copySelection?.() ?? false,
    });
  }, []);

  const setLive = (next: boolean): void => {
    const current = optionsRef.current;
    if (current.setLive) current.setLive(next);
    else setFullTerminalInputMode(next, current.sendCompose, () => undefined);
  };

  return <div
    ref={padRef}
    className={dense ? "full-terminal-pad is-dense" : "full-terminal-pad"}
    data-input-mode={live ? "live" : "compose"}
  >
    {/* Its height is terminal rows here: it never folds open or shut. */}
    <AttachmentTray compact={keyboardOpen} instant />
    <FullTerminalPadControls optionsRef={optionsRef} padRef={padRef} collapsible={pointer} dense={dense} onPage={onPage} />
    {live
      ? <FullTerminalLiveRow optionsRef={optionsRef} pointer={pointer} />
      : <FullTerminalCompose send={(text, enter) => optionsRef.current.sendCompose(text, enter)} keysButton={pointer} />}
    {pointer && <InputModeSwitch live={live} onChange={setLive}
      hints={live ? [t("deskDock.hintLive"), t("deskDock.hintBatch")] : [t("deskDock.hintBatch"), t("deskDock.hintLive")]} />}
  </div>;
}
