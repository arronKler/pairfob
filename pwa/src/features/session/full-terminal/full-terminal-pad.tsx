import { flushSync } from "react-dom";
import { ChevronDown, Ellipsis } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { composeFocused, composeIME, composeLive } from "../compose-store";
import { sessionMayTakeFocus } from "../focus";
import { useCompose } from "../hooks";
import { usePreferences } from "../../settings/hooks";
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
import { FullTerminalLiveStop } from "./full-terminal-stop";
import { AttachButton } from "../attachments/attach-button";
import { AttachmentTray } from "../attachments/attachment-tray";
import { DockKeysButton, InputModeSwitch, useSendAttachments } from "../guided/compose-controls";
import { useDeskPointer, useKeyboardHintsInPlace } from "../desk-pointer";
import { Button } from "../../../shared/ui/primitives";
import { PadChromeButton } from "../compose-focus";
import { SessionSlashPad } from "../guided/session-slash-pad";

function FullTerminalKeyButton({ spec, onKey }: { spec: KeySpec; onKey: (key: string, el: HTMLElement) => void }) {
  return <PadKey spec={spec} onPress={(el) => {
    for (const key of withModifiers(spec.key)) onKey(key, el);
  }} />;
}

function FullTerminalKeyboardButton({
  keyboard,
}: {
  keyboard: FullTerminalControlsOptions["keyboard"];
}) {
  const open = useSyncExternalStore(subscribeFullTerminalKeyboard, fullTerminalKeyboardOpen, fullTerminalKeyboardOpen);
  const keyboardRef = useRef(keyboard);
  keyboardRef.current = keyboard;
  useLayoutEffect(() => {
    notifyFullTerminalKeyboard(keyboardRef.current.isOpen());
  }, []);
  // Focus synchronously in the completed click. Focusing on pointerdown can
  // race the remaining tap's default focus handling and iOS keyboard updates.
  return <PadChromeButton
    type="button"
    className="full-terminal-kb"
    aria-pressed={open ? "true" : "false"}
    aria-label={open ? t("ft.kbHide") : t("ft.kbOpen")}
    onClick={() => {
      keyboardRef.current.toggle();
      notifyFullTerminalKeyboard(keyboardRef.current.isOpen());
    }}
  >{open ? t("ft.kbHide") : t("ft.kbType")}</PadChromeButton>;
}

/**
 * Where a live terminal's keys go, drawn where the compose field would be and
 * worded as the guided session's live field is: one mode, one name for it. The
 * terminal already has the keyboard; pressing this hands it back after a click
 * elsewhere took it.
 */
function FullTerminalLiveField({ onFocus }: { onFocus: () => void }) {
  return <div className="compose-field is-live full-terminal-live-field">
    <span className="compose-live-tag" aria-hidden="true">{t("compose2.liveTag")}</span>
    <Button className="full-terminal-live-focus" aria-label={t("deskDock.liveFieldAria")} onClick={onFocus}>
      <span className="full-terminal-live-label">{t("compose.livePh")}</span>
    </Button>
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
  /** A phone on its side: one row of keys to a page, and the keyboard button down in the live row. */
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
  const compose = useCompose();
  const preferences = usePreferences();
  const live = compose.composeLive;
  const expanded = preferences.keysExpanded;

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
    {live && !collapsible && !dense && <FullTerminalKeyboardButton keyboard={optionsRef.current.keyboard} />}
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
 * Complete-terminal pad + batch compose.
 * Keys go through `options.sendKey` (withModifiers), never the guided session key queue.
 * Compose is a sibling of the controls so expand/slash morphs do not remount the field.
 * Keep `options` callbacks stable across chrome updates.
 *
 * Driven by a mouse beside the list, the keys wait behind "按键", the 组字 / 实时
 * switch sits under the field, and live input shows where the keyboard went
 * and keeps 停止 beside it while the agent works.
 *
 * On a phone turned on its side the finger's pad is dense (`is-dense`): one row
 * of keys to a page, and in live input the keyboard button takes the compose
 * field's place in the bottom row instead of a row of its own.
 */
export function FullTerminalPad({ options, onPage }: FullTerminalPadProps) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const padRef = useRef<HTMLDivElement>(null);
  const compose = useCompose();
  const live = compose.composeLive;
  const keyboardOpen = useSoftKeyboardOpen();
  const attachments = useSendAttachments();
  const hardware = options.hardwareKeyboard;
  const pointer = useDeskPointer();
  const dense = useShortLandscape() && !pointer;
  const keysInPlace = useKeyboardHintsInPlace();

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
    <AttachmentTray compact={keyboardOpen} />
    <FullTerminalPadControls optionsRef={optionsRef} padRef={padRef} collapsible={pointer} dense={dense} onPage={onPage} />
    {live && <div className="full-terminal-live-actions">
      <AttachButton labeled={!pointer && !dense} />
      {/* In the row that is already there: a line of its own would resize the terminal at the first key. */}
      {keysInPlace && <p className="full-terminal-live-hint">{t("deskDock.liveKeysPh")}</p>}
      {dense && <FullTerminalKeyboardButton keyboard={optionsRef.current.keyboard} />}
      {pointer && <FullTerminalLiveField onFocus={() => optionsRef.current.keyboard.open()} />}
      {pointer && <DockKeysButton />}
      {/* One trailing action, as in 组字: files in the tray make it send, otherwise a working agent makes it stop. */}
      {attachments.total > 0 ? <Button className="full-terminal-live-send"
        onClick={() => sendFullTerminalAttachments(optionsRef.current.sendCompose, () => undefined)}>
        {t("compose2.sendAttachments")}
      </Button> : pointer && <FullTerminalLiveStop send={(text, enter) => optionsRef.current.sendCompose(text, enter)} />}
    </div>}
    {!live && <FullTerminalCompose send={(text, enter) => optionsRef.current.sendCompose(text, enter)} keysButton={pointer} />}
    {pointer && <InputModeSwitch live={live} onChange={setLive}
      hints={live ? [t("deskDock.hintLive"), t("deskDock.hintBatch")] : [t("deskDock.hintBatch"), t("deskDock.hintLive")]} />}
  </div>;
}
