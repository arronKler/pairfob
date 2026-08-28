import { SLASH_COMMANDS } from "../../lib/slash-commands";
import { node } from "../../lib/dom";
import { render } from "../../paint";
import { savePadKind, state, type PadKind } from "../../state";
import { clearModifiers } from "../keypad";
import { setComposeText } from "./compose";

const PAD_KIND_LABEL = "扩展键盘形态";

function selectPadKind(kind: PadKind): void {
  if (state.padKind === kind) return;
  clearModifiers();
  state.padKind = kind;
  savePadKind();
  render();
}

export function padModeBar(): HTMLElement {
  const bar = node("div", "seg pad-mode");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", PAD_KIND_LABEL);
  for (const option of [
    { kind: "keys" as const, label: "按键" },
    { kind: "slash" as const, label: "命令" },
  ]) {
    const selected = state.padKind === option.kind;
    const item = node("button", `seg-item${selected ? " on" : ""}`, option.label);
    item.type = "button";
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    item.addEventListener("pointerdown", (event) => event.preventDefault());
    item.addEventListener("click", () => selectPadKind(option.kind));
    bar.append(item);
  }
  return bar;
}

export function slashPad(): HTMLElement {
  const row = node("div", "slash-pad");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Agent 常用命令");
  for (const command of SLASH_COMMANDS) {
    const el = node("button", "key slash-cmd", command.label);
    el.type = "button";
    el.setAttribute("aria-label", command.aria ?? `插入 ${command.label}`);
    el.addEventListener("pointerdown", (event) => event.preventDefault());
    el.addEventListener("click", () => setComposeText(command.token));
    row.append(el);
  }
  return row;
}
