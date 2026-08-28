import { button, node } from "../../lib/dom";
import { rowPath, rowText } from "../../lib/termrow";
import { render } from "../../paint";
import { haptic, showError, showStatus, state } from "../../state";
import { insertCompose } from "./compose";
import { toggleTermSelect } from "./term";
import { type PaneModel } from "./model";

export function openRow(index: number): void {
  state.paneRow = state.paneRow === index ? null : index;
  haptic(6);
  render();
}

export function closeRow(): void {
  if (state.paneRow === null) return;
  state.paneRow = null;
  render();
}

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showStatus(done);
  } catch {
    showError("浏览器没有允许复制。");
  }
  state.paneRow = null;
  render();
}

/**
 * Contextual bar for the tapped row. Lives in the pane's flex column rather
 * than floating over the buffer, so acting on a row never hides it.
 */
export function rowBar(model: PaneModel): HTMLElement | null {
  const index = state.paneRow;
  if (index === null) return null;
  const raw = model.texts[index];
  if (raw === undefined) return null;
  const text = rowText(raw);
  if (!text) {
    state.paneRow = null;
    return null;
  }
  const bar = node("div", "row-bar");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "这一行的操作");
  bar.append(node("p", "row-quote", text));
  const actions = node("div", "row-actions");
  actions.append(button("复制整行", "row-act", () => copy(text, "已复制这一行。")));
  const path = rowPath(raw);
  if (path) actions.append(button(`复制 ${path}`, "row-act", () => copy(path, "已复制路径。")));
  actions.append(
    button("引用到输入框", "row-act", () => {
      insertCompose(text);
      state.paneRow = null;
      render();
    }),
  );
  actions.append(button("选择文本", "row-act", () => toggleTermSelect(true)));
  actions.append(button("关闭", "row-act row-act-ghost", closeRow));
  bar.append(actions);
  return bar;
}
