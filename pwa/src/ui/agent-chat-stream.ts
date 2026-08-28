import { button, node } from "../lib/dom";
import { markdownEl } from "../lib/agent-markdown";
import {
  groupAgentTurns,
  processTitle,
  stepKey,
  stepSummary,
  turnKey,
  type AgentTurn,
} from "../lib/agent-trace-view";
import type { AgentTraceItem } from "../lib/operations";
import { state } from "../state";

export type DetailsState = {
  open: Set<string>;
  closed: Set<string>;
};

export function emptyDetails(): DetailsState {
  return { open: new Set(), closed: new Set() };
}

export function readDetailsState(stream: HTMLElement | null): DetailsState {
  const open = new Set<string>();
  const closed = new Set<string>();
  if (!stream) return { open, closed };
  for (const nodeEl of stream.querySelectorAll("details[data-key]")) {
    const card = nodeEl as HTMLDetailsElement;
    const key = card.dataset.key;
    if (!key) continue;
    if (card.dataset.autoOpen === "1") {
      if (card.dataset.user === "closed") closed.add(key);
      else if (card.dataset.user === "open") open.add(key);
      continue;
    }
    if (card.dataset.user === "closed") closed.add(key);
    else if (card.open || card.dataset.user === "open") open.add(key);
  }
  return { open, closed };
}

function bindToggle(card: HTMLDetailsElement): void {
  card.addEventListener("toggle", () => {
    if (card.dataset.autoOpen === "1" && card.open) return;
    card.dataset.user = card.open ? "open" : "closed";
    delete card.dataset.autoOpen;
  });
}

function applyOpen(card: HTMLDetailsElement, key: string, auto: boolean, kept: DetailsState): void {
  card.dataset.key = key;
  if (kept.closed.has(key)) {
    card.dataset.user = "closed";
    card.open = false;
  } else if (kept.open.has(key)) {
    card.dataset.user = "open";
    card.open = true;
  } else if (auto) {
    card.dataset.autoOpen = "1";
    card.open = true;
  } else {
    card.open = false;
  }
  bindToggle(card);
}

function stepCard(item: AgentTraceItem, kept: DetailsState): HTMLElement {
  const card = node("details", `agent-step agent-${item.type}`);
  applyOpen(card, stepKey(item), false, kept);
  const summary = node("summary", "agent-step-summary", stepSummary(item));
  card.append(summary);
  if (item.type === "thinking" && item.text) card.append(node("pre", "agent-step-body", item.text));
  if (item.input) {
    card.append(node("p", "agent-step-label", "参数"));
    card.append(node("pre", "agent-step-body", item.input));
  }
  if (item.output) {
    card.append(node("p", "agent-step-label", "结果"));
    card.append(node("pre", "agent-step-body", item.output));
  }
  if (item.type === "tool" && !item.input && !item.output && item.text) {
    card.append(node("pre", "agent-step-body", item.text));
  }
  return card;
}

function processCard(turn: AgentTurn, live: boolean, kept: DetailsState): HTMLElement {
  const card = node("details", "agent-process");
  applyOpen(card, `p:${turnKey(turn)}`, live, kept);
  card.append(node("summary", "agent-process-summary", processTitle(turn.steps, live)));
  const body = node("div", "agent-process-body");
  for (const step of turn.steps) body.append(stepCard(step, kept));
  card.append(body);
  return card;
}

function userBubble(item: AgentTraceItem): HTMLElement {
  const article = node("article", "agent-user");
  article.append(node("strong", "agent-user-role", "你"));
  article.append(node("div", "agent-user-text", item.text || ""));
  return article;
}

function assistantReply(item: AgentTraceItem): HTMLElement {
  const article = node("article", "agent-assistant");
  article.append(markdownEl(item.text || ""));
  return article;
}

function paintTurn(turn: AgentTurn, live: boolean, kept: DetailsState, into: HTMLElement): void {
  if (turn.user) into.append(userBubble(turn.user));
  if (turn.steps.length) into.append(processCard(turn, live, kept));
  else if (live && !turn.replies.length) into.append(node("p", "agent-live", "正在执行…"));
  for (const reply of turn.replies) into.append(assistantReply(reply));
}

export function paintAgentStream(opts: {
  items: AgentTraceItem[];
  working: boolean;
  emptyMessage: string;
  note?: string;
  busy?: boolean;
  kept?: DetailsState;
  blocked?: boolean;
  onConfirm?: () => void;
  onNeedOlder?: () => void;
}): HTMLElement {
  const stream = node("div", "agent-stream");
  const inner = node("div", "agent-stream-inner");
  stream.setAttribute("role", "log");
  stream.setAttribute("aria-label", "对话");
  stream.setAttribute("aria-busy", String(opts.busy === true));
  stream.tabIndex = 0;
  const kept = opts.kept ?? emptyDetails();
  if (opts.blocked) {
    const banner = node("p", "notice notice-status agent-blocked", "Agent 在终端里等你确认。");
    banner.append(" ", button("去确认", "btn btn-small", () => opts.onConfirm?.()));
    inner.append(banner);
  }
  if (!opts.items.length) {
    inner.append(node("p", "empty-sub", opts.emptyMessage));
  }
  const turns = groupAgentTurns(opts.items);
  for (const [index, turn] of turns.entries()) {
    paintTurn(turn, opts.working && index === turns.length - 1, kept, inner);
  }
  if (opts.note && opts.items.length) {
    inner.prepend(node("p", "notice notice-status", opts.note));
  }
  stream.append(inner);
  stream.addEventListener("scroll", () => {
    const follow = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 32;
    state.agentTraceFollow = follow;
    if (stream.scrollTop < 32) opts.onNeedOlder?.();
  }, { passive: true });
  return stream;
}
