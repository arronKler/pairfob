import { beginAddComputer, forgetComputer, switchComputer } from "../computers";
import { computerTitle } from "../lib/computer-catalog";
import { button, node } from "../lib/dom";
import { formatDeviceAge } from "../lib/ui-model";
import { render } from "../paint";
import { app, state } from "../state";
import { isDesk } from "../viewport";
import { backBar, brandNode, chevron, noteNode } from "./chrome";

function computerMeta(daemonId: string, lastSeen?: number): string {
  const current = state.phase === "live" && state.credential?.daemonId === daemonId;
  if (current) return "当前连接";
  if (state.lastUsedDaemonId === daemonId) return `上次使用 · ${formatDeviceAge(lastSeen)}`;
  return lastSeen ? `最近使用：${formatDeviceAge(lastSeen)}` : "尚未连上过";
}

function computerRow(pair: typeof state.computers[number]): HTMLElement {
  const current = state.phase === "live" && state.credential?.daemonId === pair.daemonId;
  const row = node("div", "computer-row");
  const select = button("", `switch-item${current ? " on" : ""}`, () => void switchComputer(pair.daemonId));
  const main = node("span", "switch-main");
  const head = node("span", "switch-head");
  head.append(node("span", "switch-name", computerTitle(pair)));
  if (current) head.append(node("span", "pill pill-live", "当前"));
  main.append(head, node("span", "switch-meta", computerMeta(pair.daemonId, pair.lastSeen || pair.createdAt)));
  select.append(main, chevron());
  const forget = button("忘记", "computer-forget", () => void forgetComputer(pair.daemonId));
  forget.setAttribute("aria-label", `从这台手机去掉 ${computerTitle(pair)}`);
  row.append(select, forget);
  return row;
}

export function fillComputers(container: HTMLElement | DocumentFragment, withBack: boolean): void {
  if (withBack) {
    container.append(
      backBar("电脑", () => {
        state.screen = isDesk() && state.paneId ? "pane" : "home";
        render();
      }),
    );
  } else {
    container.append(brandNode());
    container.append(node("h1", "prelude-title", state.computers.length > 1 ? "选择电脑" : "连不上电脑"));
    container.append(
      node(
        "p",
        "lede",
        state.computers.length > 1
          ? "这台手机已经配对过多台电脑。连其中一台，或再添加一台。"
          : "电脑现在不在线。若刚合盖，电脑可能已经睡眠。确认电脑醒着且 pairfobd 在跑后再点下面重试，或添加另一台电脑。",
      ),
    );
  }
  const list = node("div", "computer-list");
  state.computers.forEach((pair) => list.append(computerRow(pair)));
  container.append(list);
  container.append(button("添加另一台电脑", "btn btn-ghost computer-add", beginAddComputer));
  container.append(node("p", "lede", "另一台电脑要先装 pairfobd，再执行 pairfobd pair。"));
  const error = noteNode();
  if (error) container.append(error);
}

export function renderComputers(): void {
  const root = node("div", state.phase === "live" ? "page settings-page" : "page");
  fillComputers(root, state.phase === "live");
  app.replaceChildren(root);
}
