import { button, node } from "./dom.ts";
import { t } from "./i18n.ts";
import { messageOf } from "./notices.ts";
import {
  OPERATION_INPUT_LIMITS,
  fitOperationPrompt,
  parseWorktrees,
  type CreateConversationInput,
  type CreateTabInput,
  type CreateWorktreeInput,
  type LayoutDirection,
  type OpenWorktreeInput,
  type SplitDirection,
  type SplitPaneInput,
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
  if (!path && !branch) return t("form.needPathOrBranch");
  if (path && branch) return t("form.pathXorBranch");
  return null;
}

export function splitRatioError(raw: string): string | null {
  if (!raw) return null;
  const ratio = Number(raw);
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? null : t("form.needRatio");
}

export function resizeAmountError(raw: string): string | null {
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 && amount <= 1 ? null : t("form.needAmount");
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

function selectField(
  label: string,
  name: string,
  choices: Array<{ value: string; label: string }>,
  selected?: string,
): HTMLLabelElement {
  const wrapper = node("label", "operation-field");
  wrapper.append(document.createTextNode(label));
  const select = node("select");
  select.name = name;
  for (const choice of choices) {
    const option = node("option", "", choice.label);
    option.value = choice.value;
    select.append(option);
  }
  if (selected !== undefined && choices.some((choice) => choice.value === selected)) select.value = selected;
  wrapper.append(select);
  return wrapper;
}

function actions(close: () => void, submitLabel: string): HTMLDivElement {
  const row = node("div", "action-row");
  const cancel = button(t("cancel"), "btn btn-small btn-ghost", close);
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
    (parts.form.querySelector("input, select, textarea") as HTMLElement | null)?.focus();
  });
}

export const LAST_AGENT_KIND_KEY = "pairfob:lastAgentKind";

function loadLastAgentKind(agentKinds: string[]): string {
  try {
    const raw = localStorage.getItem(LAST_AGENT_KIND_KEY);
    if (!raw) return "";
    const kind = raw.trim().slice(0, OPERATION_INPUT_LIMITS.agentKind);
    return agentKinds.includes(kind) ? kind : "";
  } catch {
    return "";
  }
}

function rememberAgentKind(kind: string): void {
  try {
    localStorage.setItem(LAST_AGENT_KIND_KEY, kind.slice(0, OPERATION_INPUT_LIMITS.agentKind));
  } catch {
    /* storage blocked; the next form just starts from a terminal again */
  }
}

function appendAgentKindField(body: HTMLElement, agentKinds: string[]): void {
  body.append(selectField(t("form.kind"), "agent_kind", [
    { value: "", label: t("form.plainTerminal") },
    ...agentKinds.map((kind) => ({ value: kind, label: kind })),
  ], loadLastAgentKind(agentKinds)));
  if (!agentKinds.length) body.append(node("p", "operation-hint", t("form.noAgentKinds")));
}

function readAgentKind(data: FormData, agentKinds: string[]): FormResult<string | undefined> {
  const agentKind = String(data.get("agent_kind") || "").trim();
  if (agentKind && !agentKinds.includes(agentKind)) return rejected(t("form.needKind"), "agent_kind");
  rememberAgentKind(agentKind);
  return accepted(agentKind || undefined);
}

export function askCreateConversation(agentKinds: string[], defaultCwd = ""): Promise<CreateConversationInput | null> {
  return formDialog(t("form.newConversation"), t("form.createOpen"), (body) => {
    body.append(field(t("form.projectDir"), "cwd", defaultCwd, "/path/to/project", true));
    appendAgentKindField(body, agentKinds);
    body.append(field(t("form.labelOptional"), "label", "", t("form.labelExample")));
    body.append(node("p", "operation-hint", t("form.conversationHint")));
  }, (data) => {
    const cwd = String(data.get("cwd") || "").trim();
    const label = String(data.get("label") || "").trim();
    if (!cwd) return rejected(t("form.needCwd"), "cwd");
    const kind = readAgentKind(data, agentKinds);
    if (!kind.ok) return kind;
    return accepted({ cwd, ...(kind.value ? { agent_kind: kind.value } : {}), ...(label ? { label } : {}) });
  });
}

export function askCreateTab(agentKinds: string[], defaultCwd = ""): Promise<Omit<CreateTabInput, "workspace_id"> | null> {
  return formDialog(t("form.newTab"), t("form.create"), (body) => {
    body.append(field(t("form.cwdOptional"), "cwd", defaultCwd));
    appendAgentKindField(body, agentKinds);
    body.append(field(t("form.tabLabelOptional"), "label"));
  }, (data) => {
    const cwd = String(data.get("cwd") || "").trim();
    const label = String(data.get("label") || "").trim();
    const kind = readAgentKind(data, agentKinds);
    if (!kind.ok) return kind;
    return accepted({ ...(cwd ? { cwd } : {}), ...(label ? { label } : {}), ...(kind.value ? { agent_kind: kind.value } : {}) });
  });
}

export function askSplitPane(agentKinds: string[], defaultCwd = ""): Promise<Omit<SplitPaneInput, "pane_id"> | null> {
  return formDialog(t("form.split"), t("form.splitAction"), (body) => {
    body.append(selectField(t("form.place"), "direction", [
      { value: "right", label: t("form.splitRight") },
      { value: "down", label: t("form.splitDown") },
    ]));
    body.append(field(t("form.cwdOptional"), "cwd", defaultCwd));
    appendAgentKindField(body, agentKinds);
    body.append(node("p", "operation-hint", t("form.splitHint")));
  }, (data) => {
    const direction = String(data.get("direction")) as SplitDirection;
    const cwd = String(data.get("cwd") || "").trim();
    if (!(["right", "down"] as string[]).includes(direction)) return rejected(t("form.needSplit"), "direction");
    const kind = readAgentKind(data, agentKinds);
    if (!kind.ok) return kind;
    return accepted({ direction, ratio: 0.5, ...(cwd ? { cwd } : {}), ...(kind.value ? { agent_kind: kind.value } : {}) });
  });
}

function askPromptText(title: string, hint: string): Promise<string | null> {
  return formDialog(title, t("form.send"), (body) => {
    const wrapper = node("label", "operation-field");
    wrapper.append(document.createTextNode(t("form.task")));
    const textarea = node("textarea");
    textarea.name = "text";
    textarea.required = true;
    textarea.maxLength = OPERATION_INPUT_LIMITS.prompt;
    textarea.rows = 7;
    wrapper.append(textarea);
    body.append(wrapper, node("p", "operation-hint", hint));
  }, (data) => {
    const text = String(data.get("text") || "").trim();
    if (!text) return rejected(t("form.needTask"), "text");
    if (fitOperationPrompt(text).truncated) return rejected(t("form.taskTooBig"), "text");
    return accepted(text);
  });
}

export function askAgentPrompt(): Promise<string | null> {
  return askPromptText(t("form.promptAgent"), t("form.taskHint"));
}

export function askWorktree(kind: "create", defaults: WorktreeDraft): Promise<CreateWorktreeInput | null>;
export function askWorktree(kind: "open", defaults: WorktreeDraft): Promise<OpenWorktreeInput | null>;
export function askWorktree(kind: "create" | "open", defaults: WorktreeDraft): Promise<CreateWorktreeInput | OpenWorktreeInput | null> {
  return formDialog(kind === "create" ? t("form.newWorktree") : t("form.openWorktree"), kind === "create" ? t("form.create") : t("open"), (body) => {
    body.append(field(kind === "open" ? t("form.pathEither") : t("form.pathOptional"), "path", defaults.path || ""));
    body.append(field(kind === "open" ? t("form.branchEither") : t("form.branchOptional"), "branch", defaults.branch || ""));
    if (kind === "create") body.append(field(t("form.baseOptional"), "base", (defaults as Partial<CreateWorktreeInput>).base || ""));
    body.append(field(t("form.labelOptional"), "label", defaults.label || ""));
    if (kind === "create") {
      body.append(node("p", "operation-hint", t("form.worktreeBlank")));
    }
    body.append(node("p", "operation-hint", defaults.cwd ? t("form.repoCwd", { cwd: defaults.cwd }) : t("form.currentWorkspace")));
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
  const title = kind === "resize" ? t("form.resizeTitle") : t("form.swapTitle");
  return new Promise((resolve) => {
    const parts = makeDialog(title);
    const pick = (choice: LayoutChoice) => {
      parts.dialog.addEventListener("close", () => resolve(choice), { once: true });
      parts.close("submit");
    };
    const hint = node(
      "p",
      "operation-hint",
      kind === "resize" ? t("form.resizeHint") : t("form.swapHint"),
    );
    parts.body.append(hint);
    const choices: Array<{ label: string; choice: LayoutChoice }> = kind === "resize"
      ? [
          { label: t("form.wider"), choice: { kind: "resize", direction: "right", amount: PANE_RESIZE_STEP } },
          { label: t("form.narrower"), choice: { kind: "resize", direction: "left", amount: PANE_RESIZE_STEP } },
          // Herdr pane.resize direction is the edge that moves. `up` grows this
          // pane; `down` shrinks it. Do not map taller to down.
          { label: t("form.taller"), choice: { kind: "resize", direction: "up", amount: PANE_RESIZE_STEP } },
          { label: t("form.shorter"), choice: { kind: "resize", direction: "down", amount: PANE_RESIZE_STEP } },
        ]
      : [
          { label: t("form.swapLeft"), choice: { kind: "swap", direction: "left" } },
          { label: t("form.swapRight"), choice: { kind: "swap", direction: "right" } },
          { label: t("form.swapUp"), choice: { kind: "swap", direction: "up" } },
          { label: t("form.swapDown"), choice: { kind: "swap", direction: "down" } },
        ];
    for (const entry of choices) {
      const el = button(entry.label, "btn");
      el.type = "button";
      el.addEventListener("click", () => pick(entry.choice));
      parts.body.append(el);
    }
    const cancel = button(t("cancel"), "btn btn-small btn-ghost", () => parts.close());
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
  if (item.label) return item.label;
  if (item.branch) return item.branch;
  const segments = item.path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || item.path || "Worktree";
}

function fillWorktreeCard(card: HTMLElement, item: WorktreeSummary, actionable: boolean): void {
  const icon = node("span", "worktree-icon");
  icon.setAttribute("aria-hidden", "true");
  const copy = node("span", "worktree-copy");
  copy.append(node("strong", "worktree-title", worktreeTitle(item)));
  if (item.label && item.branch) copy.append(node("span", "worktree-branch", item.branch));
  copy.append(node("code", "worktree-path", item.path));
  const tail = node("span", "worktree-tail");
  if (item.openWorkspaceId) tail.append(node("span", "worktree-opened", t("form.worktreeOpened")));
  if (actionable) {
    const chevron = node("span", "worktree-chevron", "›");
    chevron.setAttribute("aria-hidden", "true");
    tail.append(chevron);
  }
  card.append(icon, copy, tail);
}

export async function showWorktrees(
  load: () => Promise<unknown>,
  open?: (item: WorktreeSummary) => Promise<void>,
): Promise<void> {
  const parts = asyncDialog(t("menu.worktrees"));
  const status = node("p", "notice notice-status", t("form.worktreesLoading"));
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = node("ul", "worktree-list");
  const close = button(t("close"), "btn btn-small btn-ghost", () => parts.close());
  parts.body.append(status, list, close);
  parts.body.setAttribute("aria-busy", "true");
  try {
    const items = parseWorktrees(await load());
    status.textContent = items.length ? t("form.worktreesCount", { n: items.length }) : t("form.worktreesEmpty");
    for (const item of items) {
      const row = node("li", "worktree-item");
      if (open) {
        const openItem = open;
        const card = button("", "worktree-card", async () => {
          card.disabled = true;
          parts.body.setAttribute("aria-busy", "true");
          status.className = "notice notice-status";
          status.setAttribute("role", "status");
          status.textContent = t("form.openingNamed", { title: worktreeTitle(item) });
          try {
            await openItem(item);
            parts.close("opened");
          } catch (error) {
            status.className = "notice notice-error";
            status.setAttribute("role", "alert");
            status.textContent = messageOf(error);
            card.disabled = false;
            parts.body.setAttribute("aria-busy", "false");
          }
        });
        card.setAttribute("aria-label", t("form.openWorktreeNamed", { title: worktreeTitle(item) }));
        fillWorktreeCard(card, item, true);
        row.append(card);
      } else {
        const card = node("div", "worktree-card worktree-card-static");
        fillWorktreeCard(card, item, false);
        row.append(card);
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
