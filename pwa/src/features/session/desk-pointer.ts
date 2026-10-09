import { useSyncExternalStore } from "react";
import { pointerFine, useHardwareKeyboard } from "../../app/input-mode";
import { DESK_QUERY, isDesk } from "../../app/viewport";

/**
 * The session beside the list, driven by a mouse.
 *
 * Width decides the layout and the pointer decides the interaction. The dock's
 * collapsed keys, its input-mode switch and drag selection need both: a touch
 * tablet has the wide layout without them, and a narrow window keeps the phone
 * session whatever points at it. The style sheet switches on the same two
 * queries, so markup and style change together.
 */
const QUERIES = [DESK_QUERY, "(hover: hover) and (pointer: fine)"];

function deskLayout(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && isDesk();
}

export function deskPointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && isDesk() && pointerFine();
}

function subscribe(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const lists = QUERIES.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", listener);
  return () => { for (const list of lists) list.removeEventListener("change", listener); };
}

/** `deskPointer()` for a component whose markup follows it. */
export function useDeskPointer(): boolean {
  return useSyncExternalStore(subscribe, deskPointer, () => false);
}

/**
 * A hardware keyboard at the session beside the list, and no mouse: a touch
 * tablet whose first physical key has proved its keyboard. The line of keyboard
 * hints under the field is the mouse's row, and adding it at that first key
 * would take its height from the terminal and resize the program on the
 * computer. So what the keyboard does there (F6 leaves live input, Enter sends)
 * is said in place: in the field's placeholder, or beside the live terminal's
 * attach button.
 */
export function useKeyboardHintsInPlace(): boolean {
  const hardware = useHardwareKeyboard();
  const desk = useDeskLayout();
  const pointer = useDeskPointer();
  return hardware && desk && !pointer;
}

/**
 * The session beside the list, whatever points at it: markup that follows the
 * column's width alone, where a finger and a mouse get the same thing.
 */
export function useDeskLayout(): boolean {
  return useSyncExternalStore(subscribe, deskLayout, () => false);
}
