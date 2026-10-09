/**
 * The controls the Tab key stops at, in the order it reaches them.
 *
 * A dialog needs the list twice: to keep Tab inside it (a modal's last control
 * is followed by its first, not by the browser's own chrome), and to find the
 * control at a known place again after its content was drawn anew. The order is
 * the document's; nothing here honours a positive `tabindex`, and nothing in
 * the app sets one.
 */
const STOP = "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable='true']";

function tabIndexOf(element: HTMLElement): number {
  const stated = element.getAttribute("tabindex");
  return stated === null ? 0 : Number.parseInt(stated, 10) || 0;
}

function reachable(element: HTMLElement): boolean {
  if ((element as HTMLButtonElement).disabled || element.closest("fieldset[disabled]")) return false;
  if (tabIndexOf(element) < 0 || (element instanceof HTMLInputElement && element.type === "hidden")) return false;
  if (element.closest("[hidden], [inert]")) return false;
  // A folded `<details>` hides everything but its own summary.
  const fold = element.closest("details:not([open])");
  if (fold && !(element.tagName === "SUMMARY" && element.parentElement === fold)) return false;
  return typeof element.checkVisibility !== "function" || element.checkVisibility({ visibilityProperty: true });
}

export function tabStops(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(STOP)].filter(reachable);
}

/**
 * Keep Tab inside `dialog`: past the last stop it starts over at the first, and
 * back from the first it reaches the last. Focus that rests on nothing inside
 * (a press on the card's own padding) enters at the matching end.
 */
export function trapTab(dialog: HTMLElement, event: KeyboardEvent): void {
  // A surface that walks its own stops (the command palette) has answered already.
  if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const stops = tabStops(dialog);
  if (!stops.length) { event.preventDefault(); return; }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && active !== dialog && dialog.contains(active);
  const edge = event.shiftKey ? stops[0] : stops.at(-1)!;
  if (inside && active !== edge) return;
  event.preventDefault();
  (event.shiftKey ? stops.at(-1)! : stops[0]).focus();
}
