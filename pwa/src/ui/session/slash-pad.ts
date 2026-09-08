import { savePadKind, state, type PadKind } from "../../state";
import { clearModifiers } from "../keypad";

/** Switch the expanded pad between keys and slash chips. Drops latched modifiers. */
export function selectPadKind(kind: PadKind, repaint: () => void): void {
  if (state.padKind === kind) return;
  clearModifiers();
  state.padKind = kind;
  savePadKind();
  repaint();
}
