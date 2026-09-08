import type { AgentQuota } from "../lib/agent-quota";
import { t } from "../lib/i18n";
import { ProtocolError } from "../lib/protocol/errors";
import type { LiveSession } from "../lib/protocol/session-types";
import { adoptScreen } from "../compose-drafts";
import { state } from "../state";
import { render } from "../paint";

type QuotaView = { loading: boolean; items: AgentQuota[] | null; error: string };
export const providerNames = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok Build" };
export const views = new WeakMap<LiveSession, QuotaView>();

export async function refreshAgentQuota(): Promise<void> {
  const session = state.live;
  if (!session || !session.isConnected() || views.get(session)?.loading) return;
  const view: QuotaView = { loading: true, items: views.get(session)?.items ?? null, error: "" };
  views.set(session, view);
  if ((state.screen === "settings" || state.screen === "quota")) render();
  try {
    view.items = await session.agentQuota();
  } catch (error) {
    view.items = null;
    view.error = t(error instanceof ProtocolError && error.code === "unknown_op" ? "quota.upgrade" : "quota.failed");
  } finally {
    view.loading = false;
    if (state.live === session && (state.screen === "settings" || state.screen === "quota")) render();
  }
}

export function openQuota(): void {
  adoptScreen("quota");
  render();
  void refreshAgentQuota();
}
