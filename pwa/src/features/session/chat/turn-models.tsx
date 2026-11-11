import type { AgentTraceItem, AgentTraceModel } from "../../../lib/operations";
import { t } from "../../../lib/i18n";

/** Only this turn's records; no pane tokens, agent defaults or latest settings. */
export function turnModels(items: AgentTraceItem[]): AgentTraceModel[] | undefined {
  if (!items.some(item => item.models !== undefined)) return undefined;
  const models = new Map<string, AgentTraceModel>();
  for (const item of items) for (const model of item.models ?? []) {
    models.set(JSON.stringify([model.model, model.effort, model.source]), model);
  }
  return [...models.values()];
}

export function modelSummary(models: AgentTraceModel[] | undefined): string {
  if (models === undefined) return "";
  if (!models.length) return t("work.modelUnknown");
  if (models.length > 1) return t("work.multipleModels");
  return [models[0].model, models[0].effort].filter(Boolean).join(" · ");
}

const MODEL_SOURCE_KEYS = { codex_context: "work.modelCodex", claude_message: "work.modelClaude", pi_message: "work.modelPi" } as const;

export function TurnModelDetails({ models }: { models: AgentTraceModel[] }) {
  return <div className="work-models" aria-label={t("work.modelDetails")}>
    {!models.length ? <p>{t("work.modelMissing")}</p> : models.map((model, index) => <div key={index} className="work-model-record">
      <dl>
        <div><dt>{t("work.model")}</dt><dd>{model.model}</dd></div>
        <div><dt>{t("work.thinkingEffort")}</dt><dd>{model.effort || t("work.notRecorded")}</dd></div>
      </dl>
      <p>{t(MODEL_SOURCE_KEYS[model.source])}</p>
    </div>)}
  </div>;
}
