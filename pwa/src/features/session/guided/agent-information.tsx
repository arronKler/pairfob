import { Fragment, useState } from "react";
import { useComputers } from "../../computers/hooks";
import { useAgentCard, usePaneId } from "../hooks";
import { capabilityEnabled } from "../../operations/capabilities-store";
import { useCapabilities } from "../../operations/hooks";
import { t } from "../../../lib/i18n";
import { agentStatusLabel, statusLabel } from "../../../lib/dashboard";
import { agentObservationKey, type AgentInspection } from "../../../lib/agent-inspect";
import type { AgentCard } from "../../../lib/ranking";
import type { LiveSession } from "../../../lib/protocol/session-types";
import { AgentAvatar, Button, Spinner } from "../../../shared/ui/primitives";
import { PanePage } from "./pane-page";

/** Values an agent reported, as small key/value chips; text only, never markup. */
function Tokens({ title, values }: { title: string; values?: Readonly<Record<string, string>> }) {
  if (!values || !Object.keys(values).length) return null;
  return <>
    <h3 className="pane-group-title">{title}</h3>
    <ul className="pane-info-tokens">{Object.entries(values).map(([key, value]) => <li key={key}><i>{key}</i>{value}</li>)}</ul>
  </>;
}

/**
 * The answer first (who runs here, what state it reports, which checkout),
 * then the diagnosis for when the status looks wrong. The whole page turns
 * stale when the pane or its agent changed underneath it.
 */
export function AgentInformation({ agent, session }: { agent: AgentCard; session: LiveSession }) {
  const [result, setResult] = useState<AgentInspection>();
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const [resultOwner, setResultOwner] = useState("");
  const [copied, setCopied] = useState(false);
  const current = useAgentCard(agent.paneId);
  const computer = useComputers();
  const capabilities = useCapabilities();
  const owner = agentObservationKey(agent);
  const paneId = usePaneId();
  const stale = paneId !== agent.paneId || computer.live !== session || !current || agentObservationKey(current) !== owner;
  const canInspect = !!agent.agent && capabilities.operationCapabilities.agent_inspect && !!session.agentInspect;
  const value = stale ? undefined : current;
  const inspect = async () => {
    if (stale || !canInspect || !capabilityEnabled("agent_inspect") || state === "loading") return;
    setState("loading"); setResult(undefined);
    try {
      const reply = await session.agentInspect!(agent.paneId);
      setResult(reply); setResultOwner(owner); setState("idle");
    } catch { setState("failed"); }
  };
  const copy = async (path: string) => {
    try { await navigator.clipboard.writeText(path); setCopied(true); } catch { setCopied(false); }
  };
  if (stale || !value) return <PanePage tall className="agent-information"><p role="status">{t("agentInfo.stale")}</p></PanePage>;
  const stateLabel = value.stateLabels?.[value.status];
  const empty = !value.displayAgent && !value.worktree && !value.stateLabels && !value.tokens && !value.workspaceTokens;
  return <PanePage tall className="agent-information">
    <div className="pane-info-subject">
      <AgentAvatar kind={value.agent} status={value.agent ? value.status : undefined} />
      <span className="pane-info-subject-text">
        <b>{value.displayAgent || value.agent || t("create.terminal")}</b>
        <small>{[agentStatusLabel(value), stateLabel].filter(Boolean).join(" · ")}</small>
      </span>
    </div>
    {value.worktree && <dl className="pane-info-kv">
      <dt>{t("agentInfo.project")}</dt><dd>{value.worktree.repo_name}{value.worktree.is_linked_worktree ? ` · ${t("agentInfo.worktree")}` : ""}</dd>
      <dt>{t("agentInfo.checkout")}</dt>
      <dd><Button className="pane-info-path" aria-label={t("pm.copyPathAria", { path: value.worktree.checkout_path })}
        onClick={() => void copy(value.worktree!.checkout_path)}>{value.worktree.checkout_path}</Button></dd>
    </dl>}
    <p className="sr-only" role="status">{copied ? t("pm.pathCopied") : ""}</p>
    {empty ? <p className="create-hint">{t("agentInfo.empty")}</p> : <p className="create-hint">{t("agentInfo.displayHint")}</p>}
    <Tokens title={t("pm.infoPane")} values={value.tokens} />
    <Tokens title={t("pm.infoWorkspace")} values={value.workspaceTokens} />

    <h3 className="pane-group-title pane-info-diagnose">{t("pm.infoDiagnose")}</h3>
    <p className="create-hint">{t("pm.infoDiagnoseHint")}</p>
    {canInspect ? <Button className="btn pane-inspect" disabled={state === "loading"} aria-busy={state === "loading"} onClick={() => void inspect()}>
      {state === "loading" ? <><Spinner />{t("pm.infoInspecting")}</> : t("pm.infoInspect")}</Button>
      : <p className="create-hint">{t("agentInfo.unsupported")}</p>}
    {state === "failed" && <p className="pane-page-note is-error" role="alert">{t("agentInfo.failed")}</p>}
    {result && resultOwner === owner && <>
      <dl className="pane-info-kv">
        <dt>{t("pm.infoResult")}</dt><dd>{statusLabel(result.status)}</dd>
        {([ ["agentInfo.source", result.manifest_source], ["agentInfo.version", result.manifest_version],
          ["agentInfo.rule", result.matched_rule], ["agentInfo.fallback", result.fallback_reason],
          ["agentInfo.skipped", result.skipped_reason] ] as const).map(([key, text]) => text ? <Fragment key={key}><dt>{t(key)}</dt><dd className="is-mono">{text}</dd></Fragment> : null)}
      </dl>
      {result.screen_detection_skipped && <p className="create-hint">{t("agentInfo.hooks")}</p>}
      {result.warning && <p className="create-hint" role="status">{result.warning}</p>}
      <p className="create-hint">{t("agentInfo.hint")}</p>
      {result.rules.length > 0 && <details className="pane-precise"><summary>{t("pm.infoRules", { n: String(result.rules.length) })}</summary><ul className="pane-info-rules">{result.rules.map((rule, index) =>
        <li key={index}>{rule.id} · {statusLabel(rule.state)} · {t(rule.matched ? "agentInfo.matched" : "agentInfo.unmatched")}</li>)}</ul></details>}
    </>}
  </PanePage>;
}
