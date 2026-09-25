import { flushSync } from "react-dom";
import { ChevronDown, Ellipsis } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { composeFocused, composeIME, composeLive } from "../compose-store";
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
  EXPANDED_KEYS,
  EXTRA_KEYS,
  clearModifiers,
  modifierSnapshot,
  subscribeModifiers,
  withModifiers,
  type KeySpec,
} from "../keypad/keypad";
import { PadKey } from "../keypad/pad-key";
import { dismissSoftKeyboard, useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { FullTerminalCompose } from "./full-terminal-compose-field";
import { AttachButton } from "../attachments/attach-button";
import { AttachmentTray } from "../attachments/attachment-tray";
import { useSendAttachments } from "../guided/compose-controls";
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

function FullTerminalPadControls({
  optionsRef,
  padRef,
}: {
  optionsRef: { current: FullTerminalControlsOptions };
  padRef: { current: HTMLDivElement | null };
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

  return <div className="full-terminal-pad-controls">
    {live && <FullTerminalKeyboardButton keyboard={optionsRef.current.keyboard} />}
    <div className="keys" role="group" aria-label={t("keys.primary")}>
      {PRIMARY_KEYS.map((spec) => <FullTerminalKeyButton key={spec.key} spec={spec} onKey={onKey} />)}
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
    {shown && <SessionSlashPad onSelect={selectCommand} onCustomSelect={(text) => {
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
};

/**
 * Complete-terminal pad + batch compose.
 * Keys go through `options.sendKey` (withModifiers), never the guided session key queue.
 * Compose is a sibling of the controls so expand/slash morphs do not remount the field.
 * Keep `options` callbacks stable across chrome updates.
 */
export function FullTerminalPad({ options }: FullTerminalPadProps) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const padRef = useRef<HTMLDivElement>(null);
  const compose = useCompose();
  const live = compose.composeLive;
  const keyboardOpen = useSoftKeyboardOpen();
  const attachments = useSendAttachments();
  const desk = options.desk;

  useLayoutEffect(() => {
    const keyboard = optionsRef.current.keyboard;
    if (composeLive()) {
      if (desk) keyboard.open();
    } else {
      keyboard.close();
    }
    notifyFullTerminalKeyboard(keyboard.isOpen());
  }, [live, desk]);

  return <div
    ref={padRef}
    className="full-terminal-pad"
    data-input-mode={live ? "live" : "compose"}
  >
    <AttachmentTray compact={keyboardOpen} />
    <FullTerminalPadControls optionsRef={optionsRef} padRef={padRef} />
    {live && <div className="full-terminal-live-actions">
      <AttachButton labeled />
      {attachments.total > 0 && <Button className="full-terminal-live-send"
        onClick={() => sendFullTerminalAttachments(optionsRef.current.sendCompose, () => undefined)}>
        {t("compose2.sendAttachments")}
      </Button>}
    </div>}
    {!live && <FullTerminalCompose send={(text, enter) => optionsRef.current.sendCompose(text, enter)} />}
  </div>;
}
