import { t } from "./i18n";
import { fitOperationPrompt, type CreateConversationInput, type CreateTabInput, type CreateWorktreeInput,
  type LayoutDirection, type OpenWorktreeInput, type SplitDirection, type SplitPaneInput, type WorktreeDraft } from "./operations";
import { accepted, loadLastAgentKind, openWorktreeTargetError, readAgentKind, rejected } from "./operation-form-model";
import { formDialog, OperationField, OperationFrame, OperationPrompt, OperationSelect } from "./operation-form";
import { presentModal } from "./react-modal";

function AgentKindField({ kinds }: { kinds: string[] }) {
  return <>
    <OperationSelect label={t("form.kind")} name="agent_kind" selected={loadLastAgentKind(kinds)} choices={[
      { value: "", label: t("form.plainTerminal") }, ...kinds.map(kind => ({ value: kind, label: kind })),
    ]} />
    {!kinds.length && <p className="operation-hint">{t("form.noAgentKinds")}</p>}
  </>;
}

export function askCreateConversation(agentKinds: string[], defaultCwd = ""): Promise<CreateConversationInput | null> {
  return formDialog(t("form.newConversation"), t("form.createOpen"), <>
    <OperationField label={t("form.projectDir")} name="cwd" value={defaultCwd} placeholder="/path/to/project" required />
    <AgentKindField kinds={agentKinds} />
    <OperationField label={t("form.labelOptional")} name="label" placeholder={t("form.labelExample")} />
    <p className="operation-hint">{t("form.conversationHint")}</p>
  </>, data => {
    const cwd = String(data.get("cwd") || "").trim();
    const label = String(data.get("label") || "").trim();
    if (!cwd) return rejected(t("form.needCwd"), "cwd");
    const kind = readAgentKind(data, agentKinds);
    if (!kind.ok) return kind;
    return accepted({ cwd, ...(kind.value ? { agent_kind: kind.value } : {}), ...(label ? { label } : {}) });
  });
}

export function askCreateTab(agentKinds: string[], defaultCwd = ""): Promise<Omit<CreateTabInput, "workspace_id"> | null> {
  return formDialog(t("form.newTab"), t("form.create"), <>
    <OperationField label={t("form.cwdOptional")} name="cwd" value={defaultCwd} />
    <AgentKindField kinds={agentKinds} />
    <OperationField label={t("form.tabLabelOptional")} name="label" />
  </>, data => {
    const cwd = String(data.get("cwd") || "").trim();
    const label = String(data.get("label") || "").trim();
    const kind = readAgentKind(data, agentKinds);
    if (!kind.ok) return kind;
    return accepted({ ...(cwd ? { cwd } : {}), ...(label ? { label } : {}), ...(kind.value ? { agent_kind: kind.value } : {}) });
  });
}

export function askSplitPane(agentKinds: string[], defaultCwd = ""): Promise<Omit<SplitPaneInput, "pane_id"> | null> {
  return formDialog(t("form.split"), t("form.splitAction"), <>
    <OperationSelect label={t("form.place")} name="direction" choices={[
      { value: "right", label: t("form.splitRight") }, { value: "down", label: t("form.splitDown") },
    ]} />
    <OperationField label={t("form.cwdOptional")} name="cwd" value={defaultCwd} />
    <AgentKindField kinds={agentKinds} />
    <p className="operation-hint">{t("form.splitHint")}</p>
  </>, data => {
    const direction = String(data.get("direction")) as SplitDirection;
    const cwd = String(data.get("cwd") || "").trim();
    if (!(["right", "down"] as string[]).includes(direction)) return rejected(t("form.needSplit"), "direction");
    const kind = readAgentKind(data, agentKinds);
    if (!kind.ok) return kind;
    return accepted({ direction, ratio: 0.5, ...(cwd ? { cwd } : {}), ...(kind.value ? { agent_kind: kind.value } : {}) });
  });
}

export function askAgentPrompt(): Promise<string | null> {
  return formDialog(t("form.promptAgent"), t("form.send"), <>
    <OperationPrompt /><p className="operation-hint">{t("form.taskHint")}</p>
  </>, data => {
    const text = String(data.get("text") || "").trim();
    if (!text) return rejected(t("form.needTask"), "text");
    if (fitOperationPrompt(text).truncated) return rejected(t("form.taskTooBig"), "text");
    return accepted(text);
  });
}

export function askWorktree(kind: "create", defaults: WorktreeDraft): Promise<CreateWorktreeInput | null>;
export function askWorktree(kind: "open", defaults: WorktreeDraft): Promise<OpenWorktreeInput | null>;
export function askWorktree(kind: "create" | "open", defaults: WorktreeDraft): Promise<CreateWorktreeInput | OpenWorktreeInput | null> {
  return formDialog(kind === "create" ? t("form.newWorktree") : t("form.openWorktree"),
    kind === "create" ? t("form.create") : t("open"), <>
      <OperationField label={kind === "open" ? t("form.pathEither") : t("form.pathOptional")} name="path" value={defaults.path || ""} />
      <OperationField label={kind === "open" ? t("form.branchEither") : t("form.branchOptional")} name="branch" value={defaults.branch || ""} />
      {kind === "create" && <OperationField label={t("form.baseOptional")} name="base" value={(defaults as Partial<CreateWorktreeInput>).base || ""} />}
      <OperationField label={t("form.labelOptional")} name="label" value={defaults.label || ""} />
      {kind === "create" && <p className="operation-hint">{t("form.worktreeBlank")}</p>}
      <p className="operation-hint">{defaults.cwd ? t("form.repoCwd", { cwd: defaults.cwd }) : t("form.currentWorkspace")}</p>
    </>, data => {
      const value: CreateWorktreeInput = { ...defaults };
      for (const key of ["path", "branch", "base", "label"] as const) {
        const text = String(data.get(key) || "").trim();
        if (text) value[key] = text;
        else delete value[key];
      }
      if (kind === "open") {
        const error = openWorktreeTargetError(value.path || "", value.branch || "");
        if (error) return rejected(error, value.path ? "branch" : "path");
        delete value.base;
        return accepted(value as OpenWorktreeInput);
      }
      return accepted(value);
    });
}

export type LayoutChoice = { kind: "resize"; direction: LayoutDirection; amount: number } | { kind: "swap"; direction: LayoutDirection };
const PANE_RESIZE_STEP = 0.15;

export function askLayout(kind: "resize" | "swap"): Promise<LayoutChoice | null> {
  const title = kind === "resize" ? t("form.resizeTitle") : t("form.swapTitle");
  const choices: Array<{ label: string; choice: LayoutChoice }> = kind === "resize" ? [
    { label: t("form.wider"), choice: { kind, direction: "right", amount: PANE_RESIZE_STEP } },
    { label: t("form.narrower"), choice: { kind, direction: "left", amount: PANE_RESIZE_STEP } },
    // The edge direction is frozen: up grows the pane, down shrinks it.
    { label: t("form.taller"), choice: { kind, direction: "up", amount: PANE_RESIZE_STEP } },
    { label: t("form.shorter"), choice: { kind, direction: "down", amount: PANE_RESIZE_STEP } },
  ] : [
    { label: t("form.swapLeft"), choice: { kind, direction: "left" } },
    { label: t("form.swapRight"), choice: { kind, direction: "right" } },
    { label: t("form.swapUp"), choice: { kind, direction: "up" } },
    { label: t("form.swapDown"), choice: { kind, direction: "down" } },
  ];
  return presentModal<LayoutChoice>(modal => <OperationFrame modal={modal} title={title}>
    <div className="operation-body">
      <p className="operation-hint">{t(kind === "resize" ? "form.resizeHint" : "form.swapHint")}</p>
      {choices.map(({ label, choice }) => <button key={choice.direction} type="button" className="btn" onClick={() => modal.close(choice)}>{label}</button>)}
      <button type="button" className="btn btn-small btn-ghost" onClick={modal.dismiss}>{t("cancel")}</button>
    </div>
  </OperationFrame>).result;
}
