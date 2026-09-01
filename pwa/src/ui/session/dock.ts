import { node } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { render } from "../../paint";
import { saveKeysExpanded, state } from "../../state";
import { PRIMARY_KEYS, SECONDARY_KEYS, TERTIARY_KEYS, bindModifier, clearModifiers, paintKey, type KeySpec } from "../keypad";
import { composeForm, insertNewline } from "./compose";
import { bindKeyPress } from "./keys";
import { padModeBar, slashPad } from "./slash-pad";

/**
 * Six keys is what a 390px phone fits without a scroll strip, so the primary
 * row is the set a TUI actually needs: escape, movement and delete. Everything
 * else lives one tap away instead of off the right edge.
 */
function keyButton(spec: KeySpec): HTMLButtonElement {
  const el = paintKey(spec);
  if (spec.modifier) bindModifier(el, spec.modifier);
  else bindKeyPress(el, spec.key, spec.repeat === true);
  return el;
}

function keyRow(specs: KeySpec[], label: string): HTMLElement {
  const row = node("div", "keys");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", label);
  for (const spec of specs) row.append(keyButton(spec));
  return row;
}

export function keyPad(): HTMLElement {
  const wrap = node("div", "keys-wrap");
  const primary = keyRow(PRIMARY_KEYS, t("keys.primary"));
  const more = node("button", "key key-more");
  more.type = "button";
  more.setAttribute("aria-label", t("keys.morePad"));
  more.setAttribute("aria-expanded", state.keysExpanded ? "true" : "false");
  more.addEventListener("click", () => {
    clearModifiers();
    state.keysExpanded = !state.keysExpanded;
    saveKeysExpanded();
    render();
  });
  primary.append(more);
  wrap.append(primary);
  if (state.keysExpanded) {
    wrap.append(padModeBar());
    if (state.padKind === "slash") {
      wrap.append(slashPad());
      return wrap;
    }
    const secondary = keyRow(SECONDARY_KEYS, t("keys.more"));
    const newline = node("button", "key", t("keys.newline"));
    newline.type = "button";
    newline.setAttribute("aria-label", t("keys.newlineAria"));
    newline.addEventListener("pointerdown", (event) => event.preventDefault());
    newline.addEventListener("click", insertNewline);
    secondary.append(newline);
    wrap.append(secondary, keyRow(TERTIARY_KEYS, t("keys.mods")));
  }
  return wrap;
}

export function dockNode(includeBack: boolean): { dock: HTMLElement; input: HTMLTextAreaElement } {
  const dock = node("div", "dock");
  dock.append(keyPad());
  const { form, input } = composeForm(includeBack);
  dock.append(form);
  return { dock, input };
}
