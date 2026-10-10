import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import { fitOperationPrompt, type CreateConversationInput, type CreateTabInput, type LayoutDirection, type SplitDirection,
  type SplitPaneInput } from "../../lib/operations";
import { accepted, defaultAgentKind, loadLastAgentKind, readAgentKind, rejected, type FormResult } from "./operation-form-model";
import { formDialog, OperationField, OperationPrompt, OperationSelect } from "./operation-form";

function AgentKindField({ kinds, sourceKind }: { kinds: string[]; sourceKind?: string }) {
  return <>
    <OperationSelect label={t("form.kind")} name="agent_kind" selected={defaultAgentKind(kinds, loadLastAgentKind(kinds), sourceKind)} choices={[
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

/** New-tab fields, shared by the tab dialog and the pane sheet's in-place page. */
export function CreateTabFields({ agentKinds, defaultCwd = "" }: { agentKinds: string[]; defaultCwd?: string }) {
  return <>
    <OperationField label={t("form.cwdOptional")} name="cwd" value={defaultCwd} />
    <AgentKindField kinds={agentKinds} />
    <OperationField label={t("form.tabLabelOptional")} name="label" />
  </>;
}

export function readCreateTab(data: FormData, agentKinds: string[]): FormResult<Omit<CreateTabInput, "workspace_id">> {
  const cwd = String(data.get("cwd") || "").trim();
  const label = String(data.get("label") || "").trim();
  const kind = readAgentKind(data, agentKinds);
  if (!kind.ok) return rejected(kind.message, kind.field);
  return accepted({ ...(cwd ? { cwd } : {}), ...(label ? { label } : {}), ...(kind.value ? { agent_kind: kind.value } : {}) });
}

export function askCreateTab(agentKinds: string[], defaultCwd = ""): Promise<Omit<CreateTabInput, "workspace_id"> | null> {
  return formDialog(t("form.newTab"), t("form.create"), <CreateTabFields agentKinds={agentKinds} defaultCwd={defaultCwd} />,
    data => readCreateTab(data, agentKinds));
}

/** Split fields after the caller's own `direction` control (select, preview or tiles). */
export function SplitPaneFields({ agentKinds, defaultCwd = "", direction, hint, sourceKind }: {
  agentKinds: string[]; defaultCwd?: string; direction: ReactNode; hint: string; sourceKind?: string;
}) {
  return <>
    {direction}
    <OperationField label={t("form.cwdOptional")} name="cwd" value={defaultCwd} />
    <AgentKindField kinds={agentKinds} sourceKind={sourceKind} />
    <p className="operation-hint">{hint}</p>
  </>;
}

export function readSplitPane(data: FormData, agentKinds: string[]): FormResult<Omit<SplitPaneInput, "pane_id">> {
  const direction = String(data.get("direction")) as SplitDirection;
  const cwd = String(data.get("cwd") || "").trim();
  if (!(["right", "down"] as string[]).includes(direction)) return rejected(t("form.needSplit"), "direction");
  const kind = readAgentKind(data, agentKinds);
  if (!kind.ok) return rejected(kind.message, kind.field);
  return accepted({ direction, ratio: 0.5, ...(cwd ? { cwd } : {}), ...(kind.value ? { agent_kind: kind.value } : {}) });
}

export function askSplitPane(agentKinds: string[], defaultCwd = "", target?: { direction: SplitDirection; title: string }, sourceKind?: string): Promise<Omit<SplitPaneInput, "pane_id"> | null> {
  return formDialog(t("form.split"), t(target ? "boardMenu.createSplit" : "form.splitAction"), <SplitPaneFields
    agentKinds={agentKinds} defaultCwd={defaultCwd} sourceKind={sourceKind} hint={t(target ? "boardMenu.splitHint" : "form.splitHint")}
    direction={target ? <>
      <p>{t("boardMenu.splitTarget", { title: target.title })}</p>
      <div className={`board-split-preview ${target.direction}`} aria-label={t(target.direction === "right" ? "boardMenu.right" : "boardMenu.down")}>
        <span>{target.title}</span><span>{t("boardMenu.newPane")}</span>
      </div>
      <input type="hidden" name="direction" value={target.direction} />
    </> : <OperationSelect label={t("form.place")} name="direction" choices={[
      { value: "right", label: t("form.splitRight") }, { value: "down", label: t("form.splitDown") },
    ]} />} />, data => readSplitPane(data, agentKinds));
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

export type LayoutChoice = { kind: "resize"; direction: LayoutDirection; amount: number } | { kind: "swap"; direction: LayoutDirection };
