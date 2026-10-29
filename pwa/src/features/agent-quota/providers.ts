import { QUOTA_PROVIDERS, type QuotaProvider } from "../../lib/agent-quota-v2";

/**
 * What the quota surfaces call each provider, and the order they list them in
 * when the reader has shown no preference.
 */

export type { QuotaProvider };

export const providerNames: Record<QuotaProvider, string> = {
  codex: "Codex", claude: "Claude Code", antigravity: "Antigravity",
  copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok Build", deepseek: "DeepSeek",
  "opencode-go": "OpenCode Go", "command-code": "Command Code",
};

/** Short names for the settings module rows. */
export const shortProviderNames: Record<QuotaProvider, string> = {
  codex: "Codex", claude: "Claude", antigravity: "Antigravity",
  copilot: "Copilot", cursor: "Cursor", grok: "Grok", deepseek: "DeepSeek",
  "opencode-go": "OpenCode Go", "command-code": "Command Code",
};

/**
 * Accounts in the reader's order: `order` first, as given, then the rest in the
 * catalogue's own order. Accounts of one provider keep the order they came in.
 * The order never depends on how much is left, so a row does not move when a
 * number changes.
 */
export function orderAccounts<Item extends { provider: QuotaProvider }>(items: readonly Item[], order: readonly QuotaProvider[]): Item[] {
  const rank = (provider: QuotaProvider): number => {
    const preferred = order.indexOf(provider);
    return preferred >= 0 ? preferred : order.length + QUOTA_PROVIDERS.indexOf(provider);
  };
  return items.map((item, index) => ({ item, index }))
    .sort((left, right) => rank(left.item.provider) - rank(right.item.provider) || left.index - right.index)
    .map(entry => entry.item);
}
