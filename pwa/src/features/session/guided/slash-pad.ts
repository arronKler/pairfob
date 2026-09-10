import { padKind, setPadKind, type PadKind } from "../../settings/preferences-store";
import { clearModifiers } from "../keypad/keypad";

/** Switch the expanded pad between keys and slash chips. Drops latched modifiers. */
export function selectPadKind(kind: PadKind, repaint: () => void): void {
  if (padKind() === kind) return;
  clearModifiers();
  setPadKind(kind);
  repaint();
}
