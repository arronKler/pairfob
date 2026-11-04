import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { t } from "../../../lib/i18n";
import { composeIME } from "../compose-store";
import { PadChromeButton, focusRestoresPanel } from "../compose-focus";
import { activeModifiers, modifierSnapshot, subscribeModifiers } from "./keypad";
import { modifierStatusAria, modifierStatusText } from "./modifier-status";

export type PadPanelState = "rail" | "pages";

/**
 * The floating key panel shared by the guided dock and the complete terminal.
 *
 * It is anchored above its dock and takes no layout height there, so opening
 * it never resizes the program on the computer. The handle is the way out;
 * paging and the rail's lock report ride in it, and a downward swipe closes it
 * as a tap does. Taps on the terminal or the compose field fold it too,
 * without stealing the tap from either.
 *
 * The field closes the panel, not the arm: a Ctrl, Alt or Cmd latch is the
 * chord the reader is about to finish on the field's own keyboard. The dock
 * carries a clearable latch on screen while the panel is away, and the next
 * typed character spends it. An explicit close still clears it.
 */
export function PadPanel({ panel, onClose, onFieldClose = onClose, panelRef, children }: {
  panel: PadPanelState;
  onClose: () => void;
  /** Fold for typing, keeping a chord modifier the field keyboard will spend. */
  onFieldClose?: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  useSyncExternalStore(subscribeModifiers, modifierSnapshot, modifierSnapshot);
  const mods = activeModifiers();
  const close = useRef(onClose);
  close.current = onClose;
  const fold = useRef(onFieldClose);
  fold.current = onFieldClose;
  const start = useRef<number | null>(null);

  useLayoutEffect(() => {
    const up = (event: PointerEvent) => {
      const from = start.current;
      if (from === null) return;
      start.current = null;
      if (event.clientY - from > 18) close.current();
    };
    const cancel = () => { start.current = null; };
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    return () => {
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
    };
  }, []);

  useLayoutEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".pad-panel, .dock-keys")) return;
      // The field is a tap away even when it already holds the caret, where no
      // focus report will come to fold the panel. The guided terminal is a
      // reading surface, not a keyboard, so a tap there is an explicit close.
      if (target.closest(".term-stage")) close.current();
      else if (target.closest(".full-terminal-host, .full-terminal-live-focus, textarea")) fold.current();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);

  useLayoutEffect(() => {
    const field = "textarea, .full-terminal-live-focus, .xterm-helper-textarea";
    // A window that regains focus re-reports whatever held the caret while it
    // was away. That report is not the reader moving to a field, so it must not
    // fold the panel; only a focus report for a different element does.
    let active = document.activeElement instanceof Element ? document.activeElement : null;
    let regained: Element | null = null;
    const gain = () => { regained = document.activeElement instanceof Element ? document.activeElement : null; };
    const lose = () => { regained = null; };
    const out = (event: FocusEvent) => { if (event.target === active) active = null; };
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || event.target === active) return;
      active = event.target;
      const report = event.target === regained;
      regained = null;
      if (!report && !focusRestoresPanel(event.target) && event.target.matches(field)) fold.current();
    };
    const input = (event: Event) => {
      // An IME owns the field until compositionend: its updates must not fold
      // the panel or clear a lock mid-word, and the pad's Enter is the one
      // submit that finishes the composition itself.
      if (composeIME()) return;
      if (event.target instanceof Element && event.target.matches("textarea")) fold.current();
    };
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", out, true);
    document.addEventListener("input", input, true);
    window.addEventListener("focus", gain);
    window.addEventListener("blur", lose);
    return () => {
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", out, true);
      document.removeEventListener("input", input, true);
      window.removeEventListener("focus", gain);
      window.removeEventListener("blur", lose);
    };
  }, []);

  const label = mods.length ? `${t("pad.closeAria")}，${modifierStatusAria(mods)}` : t("pad.closeAria");
  return <div ref={panelRef} className="pad-panel" data-panel={panel} role="group" aria-label={t("pad.aria")}>
    <PadChromeButton
      type="button"
      className={mods.length ? "pad-panel-handle has-status" : "pad-panel-handle"}
      aria-label={label}
      onPointerDown={(event) => { start.current = event.clientY; }}
      onClick={() => { if (start.current === null) close.current(); }}
    >
      <i aria-hidden="true" />
      {mods.length > 0 && <span className="pad-handle-lock" aria-hidden="true">{modifierStatusText(mods)}</span>}
    </PadChromeButton>
    {children}
  </div>;
}