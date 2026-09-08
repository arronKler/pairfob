import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { saveKeysExpanded, state } from "../../state";
import {
  type FullTerminalControlsOptions,
  requestFullTerminalPadEnter,
  setFullTerminalComposeText,
} from "../full-terminal-compose";
import {
  fullTerminalKeyboardOpen,
  notifyFullTerminalKeyboard,
  subscribeFullTerminalKeyboard,
} from "../full-terminal-input";
import { bindPadPress } from "../key-press";
import {
  PRIMARY_KEYS,
  SECONDARY_KEYS,
  TERTIARY_KEYS,
  bindModifier,
  clearModifiers,
  modifierIsActive,
  modifierSnapshot,
  subscribeModifiers,
  withModifiers,
  type KeySpec,
} from "../keypad";
import { FullTerminalCompose } from "./full-terminal-compose";
import { PadChromeButton } from "./keep-compose-focus";
import { SessionPadModeBar, SessionSlashPad } from "./session-slash-pad";

function keyAria(spec: KeySpec): string | undefined {
  const mapped = spec.key === "up" ? t("key.up")
    : spec.key === "down" ? t("key.down")
    : spec.key === "left" ? t("key.left")
    : spec.key === "right" ? t("key.right")
    : spec.key === "backspace" ? t("key.backspace")
    : spec.aria ?? spec.label;
  return mapped || undefined;
}

function FullTerminalKeyButton({ spec, onKey }: { spec: KeySpec; onKey: (key: string, el: HTMLElement) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (spec.modifier) return bindModifier(el, spec.modifier).destroy;
    const { destroy } = bindPadPress(el, () => {
      for (const key of withModifiers(spec.key)) onKeyRef.current(key, el);
    }, { repeat: spec.repeat === true });
    return destroy;
  }, [spec.key, spec.modifier, spec.repeat]);
  const latched = Boolean(spec.modifier && modifierIsActive(spec.modifier));
  return <button
    ref={ref}
    type="button"
    className={spec.modifier ? `key key-mod${latched ? " on" : ""}` : "key"}
    aria-label={keyAria(spec)}
    aria-pressed={spec.modifier ? (latched ? "true" : "false") : undefined}
  >{spec.label ?? ""}</button>;
}

function KeyRow({ specs, label, extra, onKey }: {
  specs: KeySpec[];
  label: string;
  extra?: ReactNode;
  onKey: (key: string, el: HTMLElement) => void;
}) {
  return <div className="keys" role="group" aria-label={label}>
    {specs.map((spec) => <FullTerminalKeyButton key={spec.key} spec={spec} onKey={onKey} />)}
    {extra}
  </div>;
}

function FullTerminalKeyboardButton({
  keyboard,
}: {
  keyboard: FullTerminalControlsOptions["keyboard"];
}) {
  const open = useSyncExternalStore(subscribeFullTerminalKeyboard, fullTerminalKeyboardOpen, fullTerminalKeyboardOpen);
  const ref = useRef<HTMLButtonElement>(null);
  const keyboardRef = useRef(keyboard);
  keyboardRef.current = keyboard;
  useLayoutEffect(() => {
    notifyFullTerminalKeyboard(keyboardRef.current.isOpen());
    const el = ref.current;
    if (!el) return;
    return bindPadPress(el, () => {
      keyboardRef.current.toggle();
      notifyFullTerminalKeyboard(keyboardRef.current.isOpen());
    }).destroy;
  }, []);
  return <button
    ref={ref}
    type="button"
    className="full-terminal-kb"
    aria-pressed={open ? "true" : "false"}
    aria-label={open ? t("ft.kbHide") : t("ft.kbOpen")}
  >{open ? t("ft.kbHide") : t("ft.kbType")}</button>;
}

function FullTerminalPadControls({
  optionsRef,
  padRef,
}: {
  optionsRef: { current: FullTerminalControlsOptions };
  padRef: { current: HTMLDivElement | null };
}) {
  useSyncExternalStore(subscribeModifiers, modifierSnapshot, modifierSnapshot);
  const [, bump] = useState(0);
  const restoreCompose = (): void => {
    const field = padRef.current?.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input");
    if (field && (state.composeFocused || state.composeIME)) field.focus({ preventScroll: true });
  };
  const repaint = () => {
    bump((n) => n + 1);
    restoreCompose();
  };
  const live = state.composeLive;
  const expanded = state.keysExpanded;

  const onKey = (key: string, _el: HTMLElement): void => {
    if (!state.composeLive && key === "enter") {
      const pad = padRef.current;
      if (pad) requestFullTerminalPadEnter(pad);
      return;
    }
    optionsRef.current.sendKey(key);
  };

  const selectCommand = (text: string): void => {
    if (state.composeLive) {
      optionsRef.current.sendCompose(text, false);
      return;
    }
    const pad = padRef.current;
    if (pad) setFullTerminalComposeText(pad, text);
  };

  const more = (
    <PadChromeButton
      type="button"
      className="key key-more"
      aria-label={t("keys.morePad")}
      aria-expanded={expanded ? "true" : "false"}
      onClick={() => {
        clearModifiers();
        state.keysExpanded = !state.keysExpanded;
        saveKeysExpanded();
        repaint();
      }}
    />
  );

  return <div className="full-terminal-pad-controls">
    {live && <FullTerminalKeyboardButton keyboard={optionsRef.current.keyboard} />}
    <KeyRow specs={PRIMARY_KEYS} label={t("keys.primary")} extra={more} onKey={onKey} />
    {expanded && <SessionPadModeBar onRepaint={repaint} />}
    {expanded && state.padKind === "slash" && <SessionSlashPad onSelect={selectCommand} />}
    {expanded && state.padKind !== "slash" && <>
      <KeyRow specs={SECONDARY_KEYS} label={t("keys.more")} onKey={onKey} />
      <KeyRow specs={TERTIARY_KEYS} label={t("keys.mods")} onKey={onKey} />
    </>}
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
  const live = state.composeLive;
  const desk = options.desk;

  useLayoutEffect(() => {
    const keyboard = optionsRef.current.keyboard;
    if (state.composeLive) {
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
    <FullTerminalPadControls optionsRef={optionsRef} padRef={padRef} />
    {!live && <FullTerminalCompose send={(text, enter) => optionsRef.current.sendCompose(text, enter)} />}
  </div>;
}
