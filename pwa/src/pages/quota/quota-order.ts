import { QUOTA_PROVIDERS, type QuotaProvider } from "../../lib/agent-quota-v2";
import { loadCreateMemory, type CreateMemory } from "../../features/operations/create-memory";

/**
 * The order the quota surfaces list providers in: the reader's own, taken from
 * what the create sheet remembers. A pinned agent comes before one that is
 * not, then the one started more often; a provider none of whose agents was
 * ever pinned or started keeps the catalogue's order behind them.
 */

/** The agent kinds the computer may advertise for each provider. */
const KINDS: Record<QuotaProvider, readonly string[]> = {
  codex: ["codex", "openai-codex"],
  claude: ["claude", "claudecode"],
  antigravity: ["antigravity", "agy", "google-antigravity"],
  copilot: ["copilot", "github-copilot", "copilot-cli"],
  cursor: ["cursor", "cursor-agent", "cursor-cli"],
  grok: ["grok", "grok-cli"],
  // OpenCode Go follows the opencode agent; DeepSeek and Command Code are read
  // by key, and no agent kind of this build starts them.
  deepseek: [],
  "opencode-go": ["opencode"],
  "command-code": [],
};

export function quotaProviderOrder(memory: Pick<CreateMemory, "pinned" | "uses">): QuotaProvider[] {
  const pinned = (provider: QuotaProvider): boolean => KINDS[provider].some(kind => memory.pinned.includes(kind));
  const uses = (provider: QuotaProvider): number => KINDS[provider].reduce((sum, kind) => sum + (memory.uses[kind] ?? 0), 0);
  return QUOTA_PROVIDERS.filter(provider => pinned(provider) || uses(provider) > 0)
    .sort((left, right) => Number(pinned(right)) - Number(pinned(left)) || uses(right) - uses(left)
      || QUOTA_PROVIDERS.indexOf(left) - QUOTA_PROVIDERS.indexOf(right));
}

/** The order for this device, read when a quota surface is drawn. */
export function quotaOrder(): QuotaProvider[] {
  return quotaProviderOrder(loadCreateMemory());
}
