import { button, node, showHelp, type HelpBlock } from "../lib/dom";
import { type LangPref, langPref, setLangPref, t } from "../lib/i18n";
import { runtimeLiveness, type RuntimeLiveness } from "../lib/runtime-liveness";
import { type ListGroup } from "../lib/ranking";
import { render } from "../paint";
import { clearNotice, saveListGroup, state, type Notice, type StatusTone, visibleNotice } from "../state";

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

export function appendNotice(host: ParentNode): void {
  const notice = noteNode();
  if (notice) host.append(notice);
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

export function backButton(onBack: () => void, label?: string): HTMLButtonElement {
  const back = button("‹", "icon-btn back", onBack);
  back.setAttribute("aria-label", label ?? t("chrome.back"));
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

const LIST_GROUP_OPTIONS: Array<{ id: ListGroup; key: "list.flat" | "list.space" | "list.agent" }> = [
  { id: "flat", key: "list.flat" },
  { id: "space", key: "list.space" },
  { id: "agent", key: "list.agent" },
];

const LANG_OPTIONS: Array<{
  id: LangPref;
  key: "settings.langAuto" | "settings.langZh" | "settings.langEn";
  compact: "chrome.langAuto" | "settings.langZh" | "settings.langEn";
}> = [
  { id: "auto", key: "settings.langAuto", compact: "chrome.langAuto" },
  { id: "zh", key: "settings.langZh", compact: "settings.langZh" },
  { id: "en", key: "settings.langEn", compact: "settings.langEn" },
];

function applyLangPref(next: LangPref): void {
  if (langPref() === next) return;
  setLangPref(next);
  clearNotice();
  render();
}

export function languageControl(): HTMLElement {
  const bar = node("div", "seg");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", t("settings.langAria"));
  const selectedPref = langPref();
  for (const option of LANG_OPTIONS) {
    const selected = selectedPref === option.id;
    const item = button(t(option.key), `seg-item${selected ? " on" : ""}`, () => applyLangPref(option.id));
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    bar.append(item);
  }
  return bar;
}

export function languageSelect(): HTMLSelectElement {
  const select = node("select", "lang-select");
  select.setAttribute("aria-label", t("settings.langAria"));
  const selectedPref = langPref();
  for (const option of LANG_OPTIONS) {
    const item = node("option");
    item.value = option.id;
    item.textContent = t(option.compact);
    select.append(item);
  }
  select.value = selectedPref;
  select.addEventListener("change", () => {
    applyLangPref(select.value === "en" || select.value === "zh" ? select.value : "auto");
  });
  return select;
}

export function listGroupControl(): HTMLElement {
  const bar = node("div", "seg");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", t("list.groupAria"));
  for (const option of LIST_GROUP_OPTIONS) {
    const selected = state.listGroup === option.id;
    const item = button(t(option.key), `seg-item${selected ? " on" : ""}`, () => {
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

/** Interrupt is a mutation: only a live, currently-working agent may show Stop. */
export function canInterruptAgent(status: string): boolean {
  return status === "working" && herdLiveness() === "live";
}

/** Loss of contact is never process death: only a connected session that reports `runtime=offline` is exited. */
export function herdLiveness(): RuntimeLiveness {
  return runtimeLiveness({
    connected: state.live?.isConnected() === true,
    networkOnline: state.networkOnline,
    runtimeKind: state.runtimeKind,
  });
}

export function herdStatus(): { tone: StatusTone; text: string } {
  if (!state.networkOnline) return { tone: "warn", text: t("chrome.networkOffline") };
  const verdict = herdLiveness();
  if (verdict === "unverifiable") {
    const connected = state.live?.isConnected() === true;
    return { tone: "warn", text: connected ? t("chrome.unverifiable") : t("chrome.reconnecting") };
  }
  if (verdict === "exited") return { tone: "off", text: t("chrome.herdrOff") };
  if (state.runtimeKind === "fake") return { tone: "demo", text: t("chrome.demo") };
  if (state.herdHost) return { tone: "live", text: t("chrome.connectedHost", { host: state.herdHost }) };
  return { tone: "live", text: t("chrome.connected") };
}

export function herdBanners(target: HTMLElement, status: { tone: StatusTone }): void {
  if (status.tone === "demo") target.append(bannerNode("demo", t("chrome.demoBanner")));
  else if (status.tone === "off") target.append(bannerNode("off", t("chrome.herdrOffBanner")));
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

export function setNavRow(key: string, value: string, onClick: () => void): HTMLButtonElement {
  const row = button("", "set-row set-nav", onClick);
  row.setAttribute("aria-label", key);
  row.append(node("span", "set-key", key));
  const val = node("span", "set-val");
  val.append(document.createTextNode(value), chevron());
  row.append(val);
  return row;
}

export function helpButton(title: string, blocks: HelpBlock[] | (() => HelpBlock[])): HTMLButtonElement {
  const btn = button("", "icon-btn set-help", () => {
    showHelp(title, typeof blocks === "function" ? blocks() : blocks);
  });
  btn.setAttribute("aria-label", t("settings.helpAria", { topic: title }));
  btn.setAttribute("aria-haspopup", "dialog");
  return btn;
}

export function setHeading(text: string, help?: HelpBlock[] | (() => HelpBlock[])): HTMLElement {
  const row = node("div", "set-heading");
  row.append(node("h2", "set-title", text));
  if (help) row.append(helpButton(text, help));
  return row;
}
