import { t, type CopyKey } from "../../lib/i18n";
import type { QuotaAccountRead, QuotaProvider } from "../../lib/agent-quota-v2";

/**
 * What to tell the reader about an account that has no numbers: one line that
 * says what is wrong, the steps that fix it and, where one exists, the exact
 * command to run on the computer. The phone never asks for a key or a path; it
 * only says what to do there.
 */
export type QuotaGuidance = { reason: string; steps: string[]; command: string | null };

const PROVIDER_HELP = {
  codex: "quota.codexHelp",
  claude: "quota.claudeHelp",
  antigravity: "quota.antigravityHelp",
  copilot: "quota.copilotHelp",
  cursor: "quota.cursorHelp",
  grok: "quota.grokHelp",
  deepseek: "quota.deepseekHelp",
  "opencode-go": "quota.opencodeGoHelp",
  "command-code": "quota.commandCodeHelp",
} as const satisfies Record<QuotaProvider, CopyKey>;

/** The sign-in command of a provider whose CLI has one that is safe to name. */
const LOGIN_COMMANDS: Partial<Record<QuotaProvider, string>> = {
  codex: "codex login", cursor: "cursor-agent login", grok: "grok login",
  "opencode-go": "opencode auth login", "command-code": "command-code login",
};

const CURSOR_FILE_STORE = "export AGENT_CLI_CREDENTIAL_STORE=file\ncursor-agent login\npairfob service install";

/**
 * `diagnose` is whether the computer has `pairfob quota list` to name: one that
 * only answers the first quota operation does not.
 */
export function quotaGuidance(account: Pick<QuotaAccountRead, "provider" | "state" | "reason" | "retry_at">, diagnose: boolean, now = Date.now() / 1000): QuotaGuidance {
  const { provider, reason } = account;
  const help = t(PROVIDER_HELP[provider]);
  if (account.state === "throttled") return { reason: throttledCopy(account.retry_at, now), steps: [], command: null };
  switch (reason) {
    case "relogin":
      return {
        reason: t("quota.reason.relogin"),
        steps: [provider === "claude" ? t("quota.fix.reloginClaude") : help],
        command: LOGIN_COMMANDS[provider] ?? null,
      };
    case "allow_keychain":
      return provider === "cursor"
        ? { reason: t("quota.reason.allowKeychain"), steps: [t("quota.cursorKeychainHelp")], command: CURSOR_FILE_STORE }
        : { reason: t("quota.reason.allowKeychain"), steps: [t("quota.fix.keychain")], command: null };
    case "choose_account":
      return { reason: t("quota.reason.chooseAccount"), steps: [t("quota.fix.chooseAccount")], command: null };
    case "setup":
      return { reason: t("quota.reason.setup"), steps: [t("quota.setupRequired")], command: "pairfob quota-setup-claude" };
    case "no_login":
      return { reason: t("quota.reason.noLogin"), steps: [help], command: null };
    case "not_installed":
      return { reason: t("quota.reason.notInstalled"), steps: [help], command: null };
    case "not_running":
      return { reason: t("quota.reason.notRunning"), steps: [help], command: null };
    case "unsupported_login":
      return { reason: t("quota.reason.unsupportedLogin"), steps: provider === "cursor" ? [t("quota.cursorUnsupportedHelp")] : [], command: null };
    case "sign_in":
      // An older computer's one answer for every login problem. Cursor's keeps
      // the Keychain way out it has always shown there.
      return provider === "cursor"
        ? { reason: t("quota.authRequired"), steps: [help, t("quota.cursorKeychainHelp")], command: CURSOR_FILE_STORE }
        : { reason: t("quota.authRequired"), steps: [help], command: null };
    default:
      return {
        reason: t(reason === "timeout" ? "quota.reason.timeout" : "quota.reason.unread"),
        steps: [t(diagnose ? "quota.fix.diagnose" : "quota.fix.retry")],
        command: diagnose ? "pairfob quota list" : null,
      };
  }
}

/** "查询太频繁，3 分钟后可以再刷新", or without the wait when the provider named none. */
export function throttledCopy(retryAt: number, now = Date.now() / 1000): string {
  const wait = retryAt - now;
  return wait > 0 ? t("quota.throttledFor", { n: Math.max(1, Math.ceil(wait / 60)) }) : t("quota.throttled");
}
