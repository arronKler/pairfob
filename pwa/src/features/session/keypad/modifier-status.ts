import { t } from "../../../lib/i18n";
import type { ActiveModifier } from "./keypad";

/** The panel's handle and the dock's latch name the same arming. */
export function modifierStatusText(mods: ActiveModifier[]): string {
  return mods.map((mod) => `${mod.label}${mod.locked ? t("pad.lockedSuffix") : ""}`).join("+");
}

export function modifierStatusAria(mods: ActiveModifier[]): string {
  return mods.map((mod) => `${mod.label} ${t(mod.locked ? "keys.modifierLocked" : "keys.modifierHint")}`).join("，");
}