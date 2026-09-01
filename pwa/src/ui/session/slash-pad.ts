import { SLASH_COMMANDS } from "../../lib/slash-commands";
import { node } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { render } from "../../paint";
import { savePadKind, state, type PadKind } from "../../state";
import { clearModifiers } from "../keypad";
import { setComposeText } from "./compose";

const PAD_KIND_LABEL = () => t("slash.padKind");

function selectPadKind(kind: PadKind, repaint: () => void): void {
  if (state.padKind === kind) return;
  clearModifiers();
  state.padKind = kind;
  savePadKind();
  repaint();
}

export function padModeBar(repaint: () => void = render): HTMLElement {
  const bar = node("div", "seg pad-mode");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", PAD_KIND_LABEL());
  for (const option of [
    { kind: "keys" as const, label: t("slash.keys") },
    { kind: "slash" as const, label: t("slash.commands") },
  ]) {
    const selected = state.padKind === option.kind;
    const item = node("button", `seg-item${selected ? " on" : ""}`, option.label);
    item.type = "button";
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    item.addEventListener("pointerdown", (event) => event.preventDefault());
    item.addEventListener("click", () => selectPadKind(option.kind, repaint));
    bar.append(item);
  }
  return bar;
}

export function slashPad(selectCommand: (text: string) => void = setComposeText): HTMLElement {
  const row = node("div", "slash-pad");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", t("slash.agentCmds"));
  for (const command of SLASH_COMMANDS) {
    const el = node("button", "key slash-cmd", command.label);
    el.type = "button";
    el.setAttribute("aria-label", command.ariaKey ? t(command.ariaKey) : t("slash.insert", { label: command.label }));
    el.addEventListener("pointerdown", (event) => event.preventDefault());
    el.addEventListener("click", () => selectCommand(command.token));
    row.append(el);
  }
  return row;
}
