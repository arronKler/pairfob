import { button, node } from "./dom.ts";
import { messageOf } from "./notices.ts";
import {
  OPERATION_INPUT_LIMITS,
  fitOperationPrompt,
  parseWorktrees,
  type CreateConversationInput,
  type CreateWorktreeInput,
  type LayoutDirection,
  type OpenWorktreeInput,
  type SplitDirection,
  type WorktreeSummary,
  type WorktreeDraft,
} from "./operations.ts";

type DialogParts = {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  body: HTMLDivElement;
  close: (result?: string) => void;
};

type FormResult<T> = { ok: true; value: T } | { ok: false; message: string; field?: string };

function accepted<T>(value: T): FormResult<T> {
  return { ok: true, value };
}

function rejected<T>(message: string, field?: string): FormResult<T> {
  return { ok: false, message, ...(field ? { field } : {}) };
}

export function openWorktreeTargetError(path: string, branch: string): string | null {
  if (!path && !branch) return "请输入路径或分支。";
  if (path && branch) return "路径和分支只能填写一个。";
  return null;
}

export function splitRatioError(raw: string): string | null {
  if (!raw) return null;
  const ratio = Number(raw);
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? null : "分屏占比必须大于 0 且小于 1，例如 0.5。";
}

export function resizeAmountError(raw: string): string | null {
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 && amount <= 1 ? null : "调整量必须大于 0 且不超过 1，例如 0.1。";
}

let serial = 0;

function makeDialog(title: string): DialogParts {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = node("dialog", "modal operation-modal");
  const form = node("form");
  form.method = "dialog";
  const titleID = `operation-title-${++serial}`;
  const heading = node("h2", "modal-title", title);
  heading.id = titleID;
  dialog.setAttribute("aria-labelledby", titleID);
  const body = node("div", "operation-body");
  form.append(heading, body);
  dialog.append(form);
  const close = (result = "cancel") => dialog.close(result);
  const openedAt = performance.now();
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (performance.now() - openedAt < 400) return;
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (performance.now() - openedAt < 400) return;
    close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, { once: true });
  return { dialog, form, body, close };
}

function field(label: string, name: string, value = "", placeholder = "", required = false): HTMLLabelElement {
  const wrapper = node("label", "operation-field");
  wrapper.append(document.createTextNode(label));
  const input = node("input");
  input.type = "text";
  input.name = name;
  input.value = value;
  input.placeholder = placeholder;
  input.required = required;
  input.maxLength = name === "label"
    ? OPERATION_INPUT_LIMITS.label
    : name === "branch"
      ? OPERATION_INPUT_LIMITS.branch
      : name === "base"
        ? OPERATION_INPUT_LIMITS.base
        : name === "path"
          ? OPERATION_INPUT_LIMITS.path
          : OPERATION_INPUT_LIMITS.cwd;
  input.autocomplete = "off";
  input.spellcheck = false;
  wrapper.append(input);
  return wrapper;
}

function selectField(label: string, name: string, choices: Array<{ value: string; label: string }>): HTMLLabelElement {
  const wrapper = node("label", "operation-field");
  wrapper.append(document.createTextNode(label));
  const select = node("select");
  select.name = name;
  for (const choice of choices) {
    const option = node("option", "", choice.label);
    option.value = choice.value;
    select.append(option);
  }
  wrapper.append(select);
  return wrapper;
}

function actions(close: () => void, submitLabel: string): HTMLDivElement {
  const row = node("div", "action-row");
  const cancel = button("取消", "btn btn-small btn-ghost", close);
  const submit = node("button", "btn btn-small btn-primary", submitLabel);
  submit.type = "submit";
  row.append(submit, cancel);
  return row;
}

function formDialog<T>(
  title: string,
  submitLabel: string,
  fill: (body: HTMLElement) => void,
  read: (data: FormData) => FormResult<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    const parts = makeDialog(title);
    fill(parts.body);
    const validation = node("p", "notice notice-error");
    validation.id = `operation-validation-${serial}`;
    validation.setAttribute("role", "alert");
    validation.hidden = true;
    parts.body.append(validation);
    parts.body.append(actions(() => parts.close(), submitLabel));
    parts.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const result = read(new FormData(parts.form));
      if (!result.ok) {
        validation.textContent = result.message;
        validation.hidden = false;
        const target = result.field ? parts.form.elements.namedItem(result.field) : null;
        if (target instanceof HTMLElement) {
          target.setAttribute("aria-invalid", "true");
          target.setAttribute("aria-describedby", validation.id);
          target.focus();
        }
        return;
      }
      parts.dialog.addEventListener("close", () => resolve(result.value), { once: true });
      parts.close("submit");
    });
    parts.form.addEventListener("input", () => {
      validation.hidden = true;
      for (const target of parts.form.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
        target.removeAttribute("aria-invalid");
        target.removeAttribute("aria-describedby");
      }
    });
    parts.dialog.addEventListener("close", () => {
      if (parts.dialog.returnValue !== "submit") resolve(null);
    }, { once: true });
    document.body.append(parts.dialog);
    parts.dialog.showModal();
    (parts.form.querySelector("input, select") as HTMLElement | null)?.focus();
  });
}

export function askCreateConversation(agentKinds: string[], defaultCwd = ""): Promise<CreateConversationInput | null> {
  return formDialog("新建会话", "新建并打开", (body) => {
    body.append(field("项目目录", "cwd", defaultCwd, "/path/to/project", true));
    if (agentKinds.length) {
      body.append(selectField("类型", "agent_kind", [
        { value: "", label: "纯终端（不启动 Agent）" },
        ...agentKinds.map((kind) => ({ value: kind, label: kind })),
      ]));
    } else {
      body.append(node("p", "operation-hint", "电脑没有可用的 Agent 类型，将创建纯终端会话。"));
    }
    body.append(field("名称（可选）", "label", "", "例如：修复登录问题"));
    body.append(node("p", "operation-hint", "会在电脑上创建会话，但不会抢走当前焦点。纯终端只打开 shell，不启动 Agent。"));
  }, (data) => {
    const cwd = String(data.get("cwd") || "").trim();
    const agentKind = String(data.get("agent_kind") || "").trim();
    const label = String(data.get("label") || "").trim();
    if (!cwd) return rejected("请输入项目目录。", "cwd");
    if (agentKind && !agentKinds.includes(agentKind)) return rejected("请选择类型。", "agent_kind");
    return accepted({ cwd, ...(agentKind ? { agent_kind: agentKind } : {}), ...(label ? { label } : {}) });
  });
}

export function askCreateTab(defaultCwd = ""): Promise<{ cwd?: string; label?: string } | null> {
  return formDialog("新建标签页", "新建", (body) => {
    body.append(field("目录（可选）", "cwd", defaultCwd));
    body.append(field("标签页名（可选）", "label"));
  }, (data) => {
    const cwd = String(data.get("cwd") || "").trim();
    const label = String(data.get("label") || "").trim();
    return accepted({ ...(cwd ? { cwd } : {}), ...(label ? { label } : {}) });
  });
}

export function askSplitPane(defaultCwd = ""): Promise<{ direction: SplitDirection; cwd?: string; ratio?: number } | null> {
  return formDialog("分屏", "再开一格", (body) => {
    body.append(selectField("位置", "direction", [
      { value: "right", label: "在右边再开一格" },
      { value: "down", label: "在下边再开一格" },
    ]));
    body.append(field("目录（可选）", "cwd", defaultCwd));
    body.append(node("p", "operation-hint", "新的一格大约占一半。手机一次只看其中一格，半屏时用铺满全屏。"));
  }, (data) => {
    const direction = String(data.get("direction")) as SplitDirection;
    const cwd = String(data.get("cwd") || "").trim();
    if (!(["right", "down"] as string[]).includes(direction)) return rejected("请选择分屏位置。", "direction");
    return accepted({ direction, ratio: 0.5, ...(cwd ? { cwd } : {}) });
  });
}

export function askAgentPrompt(): Promise<string | null> {
  return formDialog("给 Agent 发任务", "发送", (body) => {
    const wrapper = node("label", "operation-field");
    wrapper.append(document.createTextNode("任务内容"));
    const textarea = node("textarea");
    textarea.name = "text";
    textarea.required = true;
    textarea.maxLength = OPERATION_INPUT_LIMITS.prompt;
    textarea.rows = 7;
    wrapper.append(textarea);
    body.append(wrapper, node("p", "operation-hint", "任务会直接交给 Agent，不会当作终端按键输入。"));
  }, (data) => {
    const text = String(data.get("text") || "").trim();
    if (!text) return rejected("请输入任务内容。", "text");
    if (fitOperationPrompt(text).truncated) return rejected("任务内容最多 32 KiB，请缩短后再试。", "text");
    return accepted(text);
  });
}

export function askWorktree(kind: "create", defaults: WorktreeDraft): Promise<CreateWorktreeInput | null>;
export function askWorktree(kind: "open", defaults: WorktreeDraft): Promise<OpenWorktreeInput | null>;
export function askWorktree(kind: "create" | "open", defaults: WorktreeDraft): Promise<CreateWorktreeInput | OpenWorktreeInput | null> {
  return formDialog(kind === "create" ? "新建 Worktree" : "打开 Worktree", kind === "create" ? "新建" : "打开", (body) => {
    body.append(field(kind === "open" ? "路径（二选一）" : "路径（可选）", "path", defaults.path || ""));
    body.append(field(kind === "open" ? "分支（二选一）" : "分支（可选）", "branch", defaults.branch || ""));
    if (kind === "create") body.append(field("基线（可选）", "base", (defaults as Partial<CreateWorktreeInput>).base || ""));
    body.append(field("名称（可选）", "label", defaults.label || ""));
    if (kind === "create") {
      body.append(node("p", "operation-hint", "路径和分支都留空时，电脑会自动生成 Worktree 的名称和路径。"));
    }
    body.append(node("p", "operation-hint", defaults.cwd ? `仓库目录：${defaults.cwd}` : "将使用当前工作区。"));
  }, (data) => {
    const value: CreateWorktreeInput = { ...defaults };
    for (const key of ["path", "branch", "base", "label"] as const) {
      const text = String(data.get(key) || "").trim();
      if (text) value[key] = text;
      else delete value[key];
    }
    if (kind === "open") {
      const targetError = openWorktreeTargetError(value.path || "", value.branch || "");
      if (targetError) return rejected(targetError, value.path ? "branch" : "path");
      delete value.base;
      return accepted(value as OpenWorktreeInput);
    }
    return accepted(value);
  });
}

export type LayoutChoice =
  | { kind: "resize"; direction: LayoutDirection; amount: number }
  | { kind: "swap"; direction: LayoutDirection };

const PANE_RESIZE_STEP = 0.15;

export function askLayout(kind: "resize" | "swap"): Promise<LayoutChoice | null> {
  const title = kind === "resize" ? "让这一格大一点" : "和对面一格对调";
  return new Promise((resolve) => {
    const parts = makeDialog(title);
    const pick = (choice: LayoutChoice) => {
      parts.dialog.addEventListener("close", () => resolve(choice), { once: true });
      parts.close("submit");
    };
    const hint = node(
      "p",
      "operation-hint",
      kind === "resize" ? "每次大约动一点。电脑上看着不对就再点一次。" : "对调的是电脑上紧挨着的那一格。",
    );
    parts.body.append(hint);
    const choices: Array<{ label: string; choice: LayoutChoice }> = kind === "resize"
      ? [
          { label: "加宽", choice: { kind: "resize", direction: "right", amount: PANE_RESIZE_STEP } },
          { label: "变窄", choice: { kind: "resize", direction: "left", amount: PANE_RESIZE_STEP } },
          // Herdr pane.resize direction is the edge that moves. `up` grows this
          // pane; `down` shrinks it. Do not map 加高 to down.
          { label: "加高", choice: { kind: "resize", direction: "up", amount: PANE_RESIZE_STEP } },
          { label: "变矮", choice: { kind: "resize", direction: "down", amount: PANE_RESIZE_STEP } },
        ]
      : [
          { label: "和左边对调", choice: { kind: "swap", direction: "left" } },
          { label: "和右边对调", choice: { kind: "swap", direction: "right" } },
          { label: "和上边对调", choice: { kind: "swap", direction: "up" } },
          { label: "和下边对调", choice: { kind: "swap", direction: "down" } },
        ];
    for (const entry of choices) {
      const el = button(entry.label, "btn");
      el.type = "button";
      el.addEventListener("click", () => pick(entry.choice));
      parts.body.append(el);
    }
    const cancel = button("取消", "btn btn-small btn-ghost", () => parts.close());
    cancel.type = "button";
    parts.body.append(cancel);
    parts.dialog.addEventListener("close", () => {
      if (parts.dialog.returnValue !== "submit") resolve(null);
    }, { once: true });
    document.body.append(parts.dialog);
    parts.dialog.showModal();
    (parts.body.querySelector("button") as HTMLButtonElement | null)?.focus();
  });
}

function asyncDialog(title: string): DialogParts {
  const parts = makeDialog(title);
  parts.form.addEventListener("submit", (event) => event.preventDefault());
  document.body.append(parts.dialog);
  parts.dialog.showModal();
  return parts;
}

function worktreeTitle(item: WorktreeSummary): string {
  return item.label || item.branch || item.path || "Worktree";
}

export async function showWorktrees(
  load: () => Promise<unknown>,
  open?: (item: WorktreeSummary) => Promise<void>,
): Promise<void> {
  const parts = asyncDialog("Worktree");
  const status = node("p", "notice notice-status", "正在读取 Worktree…");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = node("ul", "worktree-list");
  const close = button("关闭", "btn btn-small btn-ghost", () => parts.close());
  parts.body.append(status, list, close);
  parts.body.setAttribute("aria-busy", "true");
  try {
    const items = parseWorktrees(await load());
    status.textContent = items.length ? `共 ${items.length} 个 Worktree。` : "还没有 Worktree。";
    for (const item of items) {
      const row = node("li", "worktree-item");
      const copy = node("div");
      copy.append(node("strong", "", worktreeTitle(item)));
      copy.append(node("code", "worktree-path", item.path));
      row.append(copy);
      if (open) {
        const openItem = open;
        const openButton = button("打开", "btn btn-small btn-primary", async () => {
          openButton.disabled = true;
          parts.body.setAttribute("aria-busy", "true");
          status.className = "notice notice-status";
          status.setAttribute("role", "status");
          status.textContent = `正在打开${worktreeTitle(item)}…`;
          try {
            await openItem(item);
            parts.close("opened");
          } catch (error) {
            status.className = "notice notice-error";
            status.setAttribute("role", "alert");
            status.textContent = messageOf(error);
            openButton.disabled = false;
            parts.body.setAttribute("aria-busy", "false");
          }
        });
        row.append(openButton);
      }
      list.append(row);
    }
  } catch (error) {
    status.className = "notice notice-error";
    status.setAttribute("role", "alert");
    status.textContent = messageOf(error);
  } finally {
    parts.body.setAttribute("aria-busy", "false");
  }
  close.focus();
}
