import { button, node } from "../../lib/dom";
import { haptic, state } from "../../state";

/** Right cluster shared by 控制 / 终端 / 对话: interrupt when working, then 会话操作. */
export function chromeActionCluster(onMenu: () => void): HTMLElement {
  const actions = node("div", "chrome-actions");
  const menu = button("", "icon-btn icon-more", onMenu);
  menu.setAttribute("aria-label", "会话操作");
  menu.disabled = state.operationBusy;
  actions.append(menu);
  return actions;
}

export function syncChromeStop(chrome: HTMLElement, working: boolean, onStop: () => void): void {
  const actions = chrome.querySelector(".chrome-actions");
  const mounted = chrome.querySelector(".icon-stop");
  if (!working) {
    mounted?.remove();
    return;
  }
  if (mounted || !actions) return;
  const stop = button("", "icon-btn icon-stop", () => {
    haptic(10);
    onStop();
  });
  stop.setAttribute("aria-label", "打断当前任务");
  stop.title = "打断（Esc）";
  actions.prepend(stop);
}
