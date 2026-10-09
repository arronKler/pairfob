import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Delete, type LucideIcon } from "lucide-react";
import { t } from "../../../lib/i18n";
import { keyAriaName, keycapOf, type KeySpec } from "./keys";

const KEY_ICONS: Readonly<Partial<Record<string, LucideIcon>>> = {
  up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight, backspace: Delete,
};

const KEY_ARIA = {
  up: "key.up", down: "key.down", left: "key.left", right: "key.right", backspace: "key.backspace",
  pageup: "keys.pageUp", pagedown: "keys.pageDown",
} as const;

/** The spoken name: localized for icon keys and Space, the full chord ("Ctrl+C") otherwise. */
export function keyAria(spec: KeySpec): string | undefined {
  if (Object.hasOwn(KEY_ARIA, spec.key)) return t(KEY_ARIA[spec.key as keyof typeof KEY_ARIA]);
  if (spec.key === "space") return t("pad.space");
  return keyAriaName(spec) || undefined;
}

/**
 * Keep terminal key values and text labels separate from their visual
 * representation. Three spellings share one baseline: a glyph, a word, and a
 * chord with its modifier set small above the key.
 */
export function KeyLabel({ spec }: { spec: KeySpec }) {
  const Icon = Object.hasOwn(KEY_ICONS, spec.key) ? KEY_ICONS[spec.key] : undefined;
  if (Icon) return <Icon className="keycap-icon" size={19} aria-hidden="true" />;
  const cap = keycapOf(spec);
  if (cap.kind === "chord") return <span className="keycap-chord" aria-hidden="true">
    <small>{cap.modifier}</small><b className={cap.word ? "is-word" : undefined}>{cap.text}</b>
  </span>;
  const text = spec.key === "space" ? t("pad.space") : cap.text;
  return <span className={cap.kind === "glyph" ? "keycap-glyph" : "keycap-word"}>{text}</span>;
}
