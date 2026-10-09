import { tabStops } from "./tab-stops";

/**
 * Where a form leaves the keyboard when it says no, and while it is busy.
 *
 * A refused submit keeps the reader in the field it complains about: the
 * message is about that field, and the next key belongs there. A form that
 * locks itself while its action runs must not drop focus onto the page (a
 * disabled field cannot hold it, and then no key goes anywhere until a click);
 * it moves to a control that stays, and comes back when the action is refused.
 * Every dialog form and every page pushed into a sheet goes through these two,
 * so the rule is one place.
 */

const FIELD = "input:not([type='hidden']), textarea, select";

function attribute(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Focus the field a refusal is about: the control named `field`, or the group
 * marked `data-field` with that name (a set of choices is entered at the chosen
 * one, else its first). Without a name, the field already marked invalid, else
 * the form's first field. Returns what took focus.
 */
export function focusRefused(scope: ParentNode | null | undefined, field?: string): HTMLElement | null {
  if (!scope) return null;
  const named = field
    ? scope.querySelector<HTMLElement>(`[name="${attribute(field)}"]:not([type='hidden']), [data-field="${attribute(field)}"]`) : null;
  const target = named ?? scope.querySelector<HTMLElement>("[aria-invalid='true']") ?? scope.querySelector<HTMLElement>(FIELD);
  if (!target) return null;
  const stops = target.matches(`${FIELD}, button`) ? [target] : tabStops(target);
  const stop = stops.find(control => control.getAttribute("aria-checked") === "true" || control.getAttribute("aria-pressed") === "true") ?? stops[0];
  if (!stop || (stop as HTMLInputElement).disabled) return null;
  stop.focus();
  return stop;
}

/** Whether focus rests on nothing: the page, or a control that has left it. */
function adrift(active: Element | null): boolean {
  return !active || active === document.body || !active.isConnected;
}

/**
 * Hold focus across an action that locks its form. `note` is called before the
 * form is locked and remembers the control in `form` that has focus (a field
 * that is disabled is already no longer the active one by the time the page
 * has been drawn again). `lock` is called once it is locked: focus that was in
 * the form, or is adrift, moves to `rest`, the control that stays usable.
 * `settle` is called when the form is unlocked again without having closed:
 * focus that still waits on `rest` returns to where it was, unless a refusal
 * has put it in a field meanwhile.
 */
export function holdFocus(): {
  note(form: HTMLElement | null): void;
  lock(rest: HTMLElement | null): void;
  settle(rest: HTMLElement | null): void;
} {
  let held: HTMLElement | null = null;
  return {
    note(form) {
      const active = document.activeElement;
      held = active instanceof HTMLElement && form?.contains(active) ? active : null;
    },
    lock(rest) {
      if (held === rest) held = null;
      if (rest && (held || adrift(document.activeElement))) rest.focus({ preventScroll: true });
    },
    settle(rest) {
      const back = held;
      held = null;
      const active = document.activeElement;
      if (!back?.isConnected || back.matches(":disabled")) return;
      if (active === rest || adrift(active)) back.focus({ preventScroll: true });
    },
  };
}
