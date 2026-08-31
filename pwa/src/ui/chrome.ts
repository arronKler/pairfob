import { button, node } from "../lib/dom";
import { type ListGroup } from "../lib/ranking";
import { render } from "../paint";
import { saveListGroup, state, type Notice, type StatusTone, visibleNotice } from "../state";

/** Public bugs and product feedback. Security reports stay on GitHub Advisories. */
export const ISSUE_NEW_URL = "https://github.com/arronKler/pairfob/issues/new";

export function issueLink(className: string, text: string): HTMLAnchorElement {
  const link = node("a", className, text);
  link.href = ISSUE_NEW_URL;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}

export function feedbackNode(value: Notice): HTMLParagraphElement {
  const element = node("p", `notice notice-${value.tone}`, value.text);
  element.setAttribute("role", value.tone === "error" ? "alert" : "status");
  element.setAttribute("aria-live", value.tone === "error" ? "assertive" : "polite");
  element.setAttribute("aria-atomic", "true");
  return element;
}

export function noteNode(): HTMLElement | null {
  const notice = visibleNotice();
  if (!notice) return null;
  const element = feedbackNode(notice);
  element.setAttribute("data-app-notice", "");
  return element;
}

export function spinnerNode(): HTMLElement {
  const spinner = node("span", "spinner");
  spinner.setAttribute("aria-hidden", "true");
  return spinner;
}

/** `heading` marks the wordmark as the page's h1 on screens that have no other. */
export function brandNode(dotTone: StatusTone | null = null, heading = false): HTMLElement {
  const brand = node("div", "brand");
  brand.append(node(heading ? "h1" : "span", "wordmark", "pairfob"));
  brand.append(node("span", `brand-dot${dotTone ? ` dot-${dotTone}` : ""}`));
  return brand;
}

export function statusDotNode(tone: StatusTone): HTMLElement {
  return node("span", `dot dot-${tone}`);
}

export function statusLineNode(status: { tone: StatusTone; text: string }): HTMLElement {
  const element = node("p", "statusline");
  element.append(statusDotNode(status.tone), node("span", "statusline-text", status.text));
  return element;
}

export function sectionTitle(text: string, count?: number): HTMLHeadingElement {
  const title = node("h2", "section-title", text);
  if (count !== undefined && count > 0) title.append(node("span", "section-count", String(count)));
  return title;
}

export function chevron(className = "chev"): HTMLElement {
  const el = node("span", className);
  el.setAttribute("aria-hidden", "true");
  return el;
}

export function backButton(onBack: () => void, label = "返回"): HTMLButtonElement {
  const back = button("‹", "icon-btn back", onBack);
  back.setAttribute("aria-label", label);
  return back;
}

export function groupToggle(title: string, count: number, expanded: boolean, onToggle: () => void): HTMLButtonElement {
  const heading = node("button", "group-title");
  heading.type = "button";
  heading.setAttribute("aria-expanded", expanded ? "true" : "false");
  heading.append(chevron("group-chev"), node("span", "group-name", title));
  if (count > 0) heading.append(node("span", "section-count", String(count)));
  heading.addEventListener("click", onToggle);
  return heading;
}

const LIST_GROUP_OPTIONS: Array<{ id: ListGroup; label: string }> = [
  { id: "flat", label: "全部" },
  { id: "space", label: "按工作区" },
  { id: "agent", label: "按 Agent" },
];

export function listGroupControl(): HTMLElement {
  const bar = node("div", "seg");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", "会话分组");
  for (const option of LIST_GROUP_OPTIONS) {
    const selected = state.listGroup === option.id;
    const item = button(option.label, `seg-item${selected ? " on" : ""}`, () => {
      if (state.listGroup === option.id) return;
      state.listGroup = option.id;
      state.listGroupCollapsed = {};
      saveListGroup();
      render();
    });
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    bar.append(item);
  }
  return bar;
}

export function bannerNode(kind: "warn" | "off" | "demo", text: string): HTMLElement {
  return node("p", `banner banner-${kind}`, text);
}

export function emptyNode(title: string, sub: string): HTMLElement {
  const empty = node("div", "empty");
  empty.append(node("p", "empty-title", title), node("p", "empty-sub", sub));
  return empty;
}

export function herdStatus(): { tone: StatusTone; text: string } {
  if (!state.networkOnline) return { tone: "warn", text: "手机没有网络 · 联网后自动恢复" };
  if (state.live && !state.live.isConnected()) return { tone: "warn", text: "连接中断，正在自动重连" };
  if (state.runtimeKind === "fake") return { tone: "demo", text: "演示数据 · 不是你的电脑" };
  if (state.runtimeKind === "offline") return { tone: "off", text: "电脑上的 Herdr 没有运行" };
  if (state.herdHost) return { tone: "live", text: `已连接 · ${state.herdHost}` };
  return { tone: "live", text: "已连接" };
}

export function herdBanners(target: HTMLElement, status: { tone: StatusTone }): void {
  if (status.tone === "demo") target.append(bannerNode("demo", "当前显示的是演示数据，不是你电脑上的 Herdr。"));
  else if (status.tone === "off") target.append(bannerNode("off", "电脑上的 Herdr 没有运行，打开后会自动恢复。"));
}

export function backBar(title: string, onBack: () => void): HTMLElement {
  const bar = node("div", "topbar");
  bar.append(backButton(onBack), node("h1", "topbar-title", title));
  return bar;
}

export function setRow(key: string, value: string, tone?: StatusTone): HTMLElement {
  const row = node("div", "set-row");
  row.append(node("span", "set-key", key));
  const val = node("span", "set-val");
  if (tone) val.append(statusDotNode(tone));
  val.append(document.createTextNode(value));
  row.append(val);
  return row;
}
