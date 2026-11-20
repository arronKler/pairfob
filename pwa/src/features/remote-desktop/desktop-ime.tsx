import { useRef, useState } from "react";
import { X } from "lucide-react";
import { t } from "../../lib/i18n";
import type { DesktopEvent } from "../../lib/protocol/remote-desktop";
import { Button } from "../../shared/ui/primitives";

type DesktopImeProps = {
  disabled: boolean;
  onSend: (event: DesktopEvent) => boolean;
  onClose: () => void;
};

type ModKey = "shift" | "ctrl" | "opt" | "cmd";

const MOD_DEFS: ReadonlyArray<{ id: ModKey; label: string; bit: number }> = [
  { id: "cmd", label: "⌘", bit: 8 },
  { id: "ctrl", label: "⌃", bit: 2 },
  { id: "opt", label: "⌥", bit: 4 },
  { id: "shift", label: "⇧", bit: 1 },
];

const SHORTCUT_KEYS: ReadonlyArray<{ label: string; code: string; modifiers: number; aria: string }> = [
  { label: "Esc", code: "Escape", modifiers: 0, aria: "Escape" },
  { label: "Tab", code: "Tab", modifiers: 0, aria: "Tab" },
  { label: "⌘C", code: "KeyC", modifiers: 8, aria: "Command C" },
  { label: "⌘V", code: "KeyV", modifiers: 8, aria: "Command V" },
  { label: "⌘A", code: "KeyA", modifiers: 8, aria: "Command A" },
  { label: "⌘Z", code: "KeyZ", modifiers: 8, aria: "Command Z" },
  { label: "⌘Space", code: "Space", modifiers: 8, aria: "Command Space" },
  { label: "↵", code: "Enter", modifiers: 0, aria: "Enter" },
  { label: "⌫", code: "Backspace", modifiers: 0, aria: "Backspace" },
];

export function DesktopIme({ disabled, onSend, onClose }: DesktopImeProps) {
  const [draft, setDraft] = useState("");
  const [latched, setLatched] = useState<Record<ModKey, boolean>>({
    cmd: false,
    ctrl: false,
    opt: false,
    shift: false,
  });
  const composing = useRef(false);

  function latchedMask(): number {
    return MOD_DEFS.reduce((acc, mod) => (latched[mod.id] ? acc | mod.bit : acc), 0);
  }

  function clearLatches() {
    setLatched({ cmd: false, ctrl: false, opt: false, shift: false });
  }

  function sendKey(code: string, baseModifiers: number) {
    if (disabled) return;
    const combined = baseModifiers | latchedMask();
    onSend({ kind: "key", code, modifiers: combined });
    clearLatches();
  }

  function submitDraft() {
    if (disabled || !draft) return;
    if (new TextEncoder().encode(draft).length > 4096) return;
    if (onSend({ kind: "text", text: draft })) {
      setDraft("");
    }
  }

  return (
    <div className="rd-ime-drawer" role="dialog" aria-label={t("desktop.imeTitle")}>
      <div className="rd-ime-head">
        <span className="rd-ime-title">{t("desktop.imeTitle")}</span>
        <Button className="rd-pop-close" onClick={onClose} aria-label={t("desktop.close")}>
          <X size={14} aria-hidden="true" />
        </Button>
      </div>

      <div className="rd-shortcut-row">
        {MOD_DEFS.map(mod => (
          <Button
            key={mod.id}
            className={`rd-sc-key${latched[mod.id] ? " is-latched" : ""}`}
            aria-pressed={latched[mod.id]}
            disabled={disabled}
            onClick={() => setLatched(prev => ({ ...prev, [mod.id]: !prev[mod.id] }))}
          >
            {mod.label}
          </Button>
        ))}
        <span className="rd-sc-sep" aria-hidden="true" />
        {SHORTCUT_KEYS.map(item => (
          <Button
            key={item.label}
            className="rd-sc-key"
            aria-label={item.aria}
            disabled={disabled}
            onClick={() => sendKey(item.code, item.modifiers)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      <form
        className="rd-ime-form"
        onSubmit={event => {
          event.preventDefault();
          if (composing.current) return;
          submitDraft();
        }}
      >
        {/* Never auto-focus under touch: tapping the field opens the IME intentionally. */}
        <input
          className="rd-ime-input"
          aria-label={t("desktop.text")}
          placeholder={t("desktop.imePlaceholder")}
          value={draft}
          maxLength={1024}
          autoComplete="off"
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if ((event.nativeEvent.isComposing || composing.current) && event.key === "Enter") {
              event.preventDefault();
            }
          }}
        />
        <Button type="submit" className="btn btn-primary btn-small rd-ime-send" disabled={disabled || !draft}>
          {t("desktop.send")}
        </Button>
      </form>
    </div>
  );
}
