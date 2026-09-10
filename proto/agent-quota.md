# AgentQuota

`AgentQuota` is an additive, read-only inner RPC on an Established Pairfob
session. It uses the existing encrypted transport. The origin never reads the
result. Existing RPC fields, the eleven operation capabilities, and envelope
cryptography are unchanged.

Request: `{"v":1,"id":"q1","op":"AgentQuota","params":{}}`.
All parameters are rejected; the phone cannot select an executable, path,
account, credential, or provider URL. The query observes the daemon user's
configured accounts independently of the selected pane or Herdr availability.

Result: `{"items":[...]}`, defined by `agentQuotaResult` in `rpc.schema.json`.
Each provider has `provider`, `plan`, `source`, `status`, `observed_at` (Unix
seconds), and `windows`. Each window reports `name`, `used_percent`,
`window_minutes` (zero when unknown), and `resets_at` (Unix seconds, zero when unreported). Optional `unlimited: true`
means an explicitly unlimited bucket; its used percentage is zero and the UI
shows no percentage bar.
An empty plan is unknown. Zero usage is valid. Windows are distinct quota
buckets and must not be summed or multiplied by the number of Agent sessions.

Statuses: `ok`, `stale`, `not_installed`, `not_logged_in`, `unsupported`,
`unavailable`, `setup_required`, `auth_required`, `not_running`. Missing data never means zero usage. An
expired reset timestamp does not imply renewed quota: a new sample is needed.
The UI hides percentages for expired samples and samples older than 15 minutes.

## Sources and refresh

- Codex: the local `codex app-server` using `initialize`, `account/read`, and
  `account/rateLimits/read`. No thread or turn is started. The multi-bucket
  `rateLimitsByLimitId` takes precedence over its single-bucket compatibility
  view. The provider call has an 8-second deadline and bounded output.
- Claude Code: automatic OAuth GET of `https://api.anthropic.com/api/oauth/usage`.
  Reads `CLAUDE_CONFIG_DIR/.credentials.json`, or the default macOS
  `Claude Code-credentials` Keychain service with interaction forbidden.
  Requires a readable, unexpired credential with `user:profile` scope. No login
  dialog, refresh-token rotation, settings modification, or model turn occurs.
  Custom config directories currently require the credential file.
- GitHub Copilot: fixed `https://api.github.com/copilot_internal/user` query.
  Uses `COPILOT_GITHUB_TOKEN`, otherwise the unique public GitHub credential
  across Copilot hosts/apps files, then `gh auth token --hostname github.com`
  only when no Copilot token exists. Ambiguous accounts require explicit
  selection. Enterprise tokens are never sent to github.com.
- Cursor: reads the Cursor CLI login, then GETs
  `https://cursor.com/api/usage-summary`. No editor or sqlite3 is required.
  `CURSOR_AUTH_TOKEN` takes precedence. Otherwise, the CLI's default store is
  macOS Keychain (`cursor-access-token`, account `cursor-user`), or the CLI's
  `auth.json` file on other platforms. `AGENT_CLI_CREDENTIAL_STORE=file`
  explicitly selects the file on macOS too; `memory` has no readable login.
  File paths follow the CLI: macOS `~/.cursor/auth.json`, Linux
  `$XDG_CONFIG_HOME/cursor/auth.json` (default `~/.config/cursor/auth.json`),
  Windows `%APPDATA%/Cursor/auth.json`. `CURSOR_CONFIG_DIR` does not move CLI
  credentials. Pairfob must inherit the same credential-store environment as
  the CLI. A missing or invalid selected store never falls back to another
  account. On macOS, Cursor uses the same `/usr/bin/security` credential reader
  as its CLI; authorization can differ from a JXA reader. macOS may request
  Keychain access. The read has a three-second deadline, bounded stdout and
  discarded stderr. It does not change Keychain permissions or unlock it.
  Missing credentials report `not_logged_in`; expired, denied or timed-out
  reads report `auth_required`.
  API-key-only credentials and
  custom API endpoints are unsupported. No API-key exchange, token refresh,
  model turn, browser-cookie collection, or credential write occurs.
- Antigravity: queries the already-running, same-user app/CLI through
  loopback listener ports attributed to its PID using `ps` and `lsof`.
  Uses grouped quota summaries, then legacy model quotas. No app launch,
  model turn, or availability-to-quota inference occurs. Missing process is
  reported as `not_running`; unsupported local endpoint versions are unavailable.

- Grok Build: reads the unique OIDC login from `GROK_HOME/auth.json`
  (default `~/.grok/auth.json`), then GETs
  `https://cli-chat-proxy.grok.com/v1/billing?format=credits`.
  Only explicit `config.creditUsagePercent` becomes a usage window;
  `currentPeriod.end` takes precedence over `billingPeriodEnd`; an invalid
  current-period end stays unknown rather than borrowing a billing reset. A reported
  weekly period maps to 10080 minutes. This allowance is shared across Grok
  products, not exclusive to Build. On-demand spending is not a subscription
  allowance and is never used as a fallback percentage.
  A concurrent `/v1/settings` request adds `subscription_tier_display` with a
  two-second deadline; failure does not discard the quota. Expired, missing,
  or ambiguous credentials require `grok login`; non-User or missing principal types are unsupported.
  No CLI process, model turn, token refresh, or browser-cookie collection occurs.

Gemini CLI is deliberately excluded. Each provider represents the locally
selected account, not an aggregation of multiple login profiles. Provider
endpoints other than the Codex app-server are vendor-internal interfaces and
may change. Missing, rejected or unrecognized quota data is not a full allowance.
Remote requests reject redirects and have bounded responses and deadlines.

The daemon caches a complete read for 60 seconds. Concurrent refreshes return
`rate_limited` rather than starting another process. Account-read failures
produce a provider status and do not expose raw subprocess output. The UI has
an explicit refresh button and does not poll in the background. Older daemons
return `unknown_op`, displayed as an upgrade prompt.

## Cursor CLI login

Run `cursor-agent login` as the daemon user. The CLI browser login is sufficient;
the Cursor editor is not used. macOS may ask to authorize Keychain access for
its `security` utility. A denied, locked or timed-out read stays `auth_required`;
Pairfob does not unlock the Keychain or change its access rules. To avoid relying
on Keychain authorization, the CLI also supports file storage:

```sh
export AGENT_CLI_CREDENTIAL_STORE=file
cursor-agent login
```

Use the same environment for subsequent Cursor CLI sessions and Pairfob. For a
background Pairfob service, run `pairfob service install` from the configured
shell to persist this store selector in launchd/systemd. Login tokens and API
keys are never written into the service definition. If installation sees an
explicit token, API key, or custom endpoint, it records only a nonsecret
`PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN=1` marker: without the explicit credential,
the service reports `unsupported` instead of borrowing a saved account. To
switch that service to the CLI's saved login, clear those environment overrides
(including the marker if present in the installing shell), log in, and reinstall
the service definition. Restarting an existing
service alone does not change its stored environment. API-key-only login
requires an interactive CLI login before quota can be read.

## Optional Claude statusline fallback

Automatic OAuth querying is the default; no statusline setup is necessary.
For an explicit offline fallback, set `PAIRFOB_CLAUDE_QUOTA_SOURCE=statusline`
in the daemon environment, then run:

```sh
pairfob quota-setup-claude
```

Then start a new Claude Code session and wait for a model response. This
updates `CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`).
It creates a private `settings.json.pairfob-backup` before changing anything,
preserves unrelated settings and statusline fields, and wraps the previous
statusline command so it receives the original input and retains its output.
Repeated setup is a no-op. Existing backup conflicts fail closed.

The callback is `pairfob quota-statusline [previous-statusline-command]`.
It atomically stores the quota-only sample at
`CLAUDE_CONFIG_DIR/pairfob-quota.json` with mode 0600. No transcript, prompt,
path, session ID, access token, or original payload is saved. A callback without
limits invalidates the previous sample. Existing statusline output is preserved
even when caching fails; the previous sample expires on the phone.

To disable, restore only the `statusLine` field from the backup into the current
settings (or remove it if originally absent). Keep other subsequent settings
changes. Remove `pairfob-quota.json` if the saved sample is no longer wanted.
The setup command targets macOS/Linux shell-based Claude Code installations.
It never runs as part of the read-only RPC. The daemon must see the same
`CLAUDE_CONFIG_DIR` and Codex executable/login environment as the local CLI.

## References

- [Codex app-server account reads](https://learn.chatgpt.com/docs/app-server)
- [Claude Code statusline fields](https://code.claude.com/docs/en/statusline)

- [Provider adapter reference](https://github.com/steipete/CodexBar/tree/main/Sources/CodexBarCore/Providers)
