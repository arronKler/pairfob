/**
 * The control an overlay belongs to, across a change of layout.
 *
 * Crossing a width tier draws the shell again, so the button a menu hangs from,
 * and the one focus goes back to, may have been replaced by another instance of
 * itself while the overlay stayed open. Nothing links the two, so the new one
 * is recognised by what made the old one that control: its element, its classes
 * and its name. It has to be the only such control on the page; one of several
 * alike is not guessed at.
 *
 * A control that is one of several alike by design (a row's "more" among every
 * row's) says whose it is with `data-trigger-of`: the id of the row, heading or
 * pane it acts on. Its twin is then the control of the same kind for the same
 * object, whatever its name has become since (a row's text counts its minutes),
 * and whatever state it has been marked with or cleared of: a row that drops a
 * class as it unmounts is still that row's control, while "more" and the row
 * itself never share all the classes of either.
 */
const OWNER = "data-trigger-of";

/** The classes of one are all among the other's: the same control, a state class apart. */
function sameKind(left: Element, right: Element): boolean {
  const within = (a: DOMTokenList, b: DOMTokenList) => [...a].every(name => b.contains(name));
  return within(left.classList, right.classList) || within(right.classList, left.classList);
}

function nameOf(element: Element): string {
  return element.getAttribute("aria-label") ?? element.textContent ?? "";
}

export function liveTrigger(trigger: Element | null | undefined): HTMLElement | null {
  if (!(trigger instanceof HTMLElement)) return null;
  if (trigger.isConnected) return trigger;
  const owner = trigger.getAttribute(OWNER);
  const name = nameOf(trigger);
  if (owner === null && !name) return null;
  const alike = [...document.getElementsByTagName(trigger.tagName)].filter(candidate =>
    candidate instanceof HTMLElement && candidate.getAttribute(OWNER) === owner && !candidate.closest("dialog")
    && (owner !== null ? sameKind(candidate, trigger) : candidate.className === trigger.className && nameOf(candidate) === name));
  return alike.length === 1 ? alike[0] as HTMLElement : null;
}

/**
 * Where focus goes when an overlay closes: the control that opened it, or its
 * new instance when the window was resized while the overlay was open. Without
 * a resize a trigger that is gone was removed by what the overlay did (a row
 * closed from its own menu), and a neighbour that looks like it is not it. A
 * control that names its object cannot be mistaken for a neighbour, so it is
 * followed wherever the list drew it again.
 */
export function followTrigger(trigger: HTMLElement | null): { live(): HTMLElement | null; release(): void } {
  let resized = false;
  const note = () => { resized = true; };
  window.addEventListener("resize", note);
  return {
    live: () => trigger?.isConnected ? trigger : resized || trigger?.hasAttribute(OWNER) ? liveTrigger(trigger) : null,
    release: () => window.removeEventListener("resize", note),
  };
}

/**
 * Give focus back. `home` answers when the trigger cannot take it: its row left
 * the list while the overlay was open, or its actions folded away behind the
 * row again. It is asked only while focus is nowhere, so a surface that opened
 * in the meantime keeps what it focused.
 */
export function returnFocus(trigger: HTMLElement | null, home?: () => HTMLElement | null): void {
  trigger?.focus({ preventScroll: true });
  if (!home || (trigger && document.activeElement === trigger)) return;
  const active = document.activeElement;
  if (!active || active === document.body) home()?.focus({ preventScroll: true });
}
