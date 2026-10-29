# AgentQuota and AgentQuotaV2

`AgentQuota` and `AgentQuotaV2` are additive, read-only inner RPCs on an
Established Pairfob session. They use the existing encrypted transport. The
origin never reads either result. Existing RPC fields, the eleven operation
capabilities, and envelope cryptography are unchanged.

`AgentQuota` is the first operation: at most six items, one per provider of a
closed list, each a set of percentage windows. A phone that decodes it refuses
a seventh item or a provider it does not know, so nothing can be added to it.
`AgentQuotaV2` reports the same reads as accounts and is where new providers,
several accounts of one provider and allowances that are not percentages go.
Both are answered from one read of each account; neither is deprecated.

## AgentQuota

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

## AgentQuotaV2

Request: `{"v":1,"id":"q2","op":"AgentQuotaV2","params":{}}`. As with the first
operation every parameter is rejected: the phone selects no executable, path,
account, credential, region or provider URL.

Result: `{"items":[...]}`, at most 64 accounts, defined by `agentQuotaV2Result`
in `rpc.schema.json`. An account has:

- `id`: an opaque token, unique in the result. It is the key of the account and
  nothing to show. Today each provider has one account and its `id` is the
  provider's name; a phone must not rely on that.
- `provider`: a token. A phone drops an item whose provider it cannot name and
  shows the rest; any other item that does not fit the schema refuses the
  whole result.
- `plan`: empty when unknown. Optional `scope` (`personal` or `org`), `region`,
  `label` and `source` tell one account of a provider from another; an
  ordinary single personal account carries none of the first three.
- `state` and, where the state needs one, `reason` (below).
- `observed_at`: Unix seconds of the sample in `meters`, zero with no meters.
- `retry_at`: only with `throttled`, when the provider said when to ask again.
- `meters`: at most 32.

| `state` | `reason` | Meaning | `meters` |
| --- | --- | --- | --- |
| `ok` | none | Read now. | One or more, none `unread`. |
| `partial` | none | Read now, but the provider answered for only some allowances. | Some read, some `unread`. |
| `failed` | `timeout`, `unavailable` | This read did not go through. | The last sample that worked if it is under 15 minutes old, with its own `observed_at`; otherwise none. |
| `throttled` | none | The provider refused for rate. The account is not asked again before `retry_at`. | As for `failed`. |
| `needs_action` | `relogin`, `allow_keychain`, `choose_account`, `setup` | A login is on this computer but cannot be read. | None: numbers of a login that stopped reading may be another account's. |
| `not_configured` | `no_login`, `not_installed`, `not_running`, `unsupported_login` | Nothing to read: no trace of a login, a missing command, an app that is not open, or a login (an API key) that has no subscription allowance. | None. |

`needs_action` is something for the user to fix; `not_configured` is not, and
a UI does not raise it as a task. The split depends on the provider read
looking for the login locally before any request: with no trace of one, no
request is made and the account is `not_configured`.

A meter has a `kind`, a `name` (an identifier this document lists, or the
provider's own display name), a `pool` token, and `headline: true` when it
stands for the account:

| `kind` | Fields | Notes |
| --- | --- | --- |
| `quota` | `used_percent` (0 to 100), optional `window_minutes`, `resets_at`, and optionally `used`, `limit`, `unit` together (with `scale`) | The share is always present and normalized by the daemon. The counts are for display and come whole or not at all. |
| `balance` | `amount`, `unit`, optional `scale`, `resets_at` | An amount with no ceiling. It has no share and is never drawn as one. |
| `level` | `level`: `full`, `high`, `medium`, `low`, `empty` | The provider reports a step, not a number. It is not converted to a percentage. |
| `unlimited` | optional `resets_at` | Only when the provider says so explicitly. |
| `unread` | none | An allowance the provider has but this read did not get. Never zero, never full. |

Amounts are integers with `scale` decimal places (`1240` at scale `2` is
12.40); no floating-point money crosses the wire. `unit` is one of `usd`,
`cny`, `credits`, `requests`, `hours`. A field that is zero or false is left
out. A provider that reports no ceiling gets a `balance`, or no meter, never a
`quota` with an invented limit.

Meters of one `pool` limit the same usage. Meters of different pools are never
compared, added or multiplied by the number of sessions. A summary of an
account is the tightest `quota` or `level` among its `headline` meters, else a
headline `unlimited`, else a headline `balance`; an account with no headline
meter is summed up only by a meter that is its only one. The daemon decides
which meters are headline, because it knows each provider's shapes:

| Provider | Headline | Not headline |
| --- | --- | --- |
| Codex | The bucket named `codex` (both of its windows); every bucket when none has that name | Other buckets, each its own pool |
| Claude Code | `five hour`, `seven day` | Per-model and per-feature windows, each its own pool; the statusline's `spend limit` |
| GitHub Copilot | `premium interactions` | `chat`, `completions` |
| Cursor | `Included plan` | |
| Grok Build | `Shared subscription quota` | |
| Antigravity | Every model bucket, each its own pool: none is the plan's total | |
| DeepSeek | Its only balance meter | |
| OpenCode Go | `five hour`, `seven day`, and `monthly` when the plan has one | |
| Command Code | `five hour`, `seven day`, `monthly balance` | |

Freshness is judged where it is shown. All meters of one read share the
account's `observed_at`; each is also past use once its own `resets_at` has
passed, without affecting the others. The UI shows a sample for 15 minutes.

### Versions

| Phone | Computer | Behavior |
| --- | --- | --- |
| Knows `AgentQuotaV2` | Answers it | The accounts above. |
| Knows `AgentQuotaV2` | Answers `unknown_op` | The phone asks `AgentQuota` instead, for the rest of that connection, and shows its six items as accounts. It marks Claude's two plan windows and Copilot's premium interactions as headline, as a current daemon would, and does not raise that daemon's `auth_required` as a task, since it cannot tell an expired login from none. |
| Knows only `AgentQuota` | Answers both | Unchanged: the six items in their original shape. |

Only `unknown_op` causes the fallback. A timeout, a refused session or a
malformed result is an error of the read. A status the first operation never
defined is reported on it as the nearest of its nine (a refused Keychain read
and an ambiguous login as `auth_required`; a provider's rate limit and a
timeout as `unavailable`).

### Local diagnosis

`pairfob quota list` runs the same reads once, with no cache, and prints each
account's state, plan and headline meters. It prints no credential, path or
raw provider reply. It reads with the environment of the shell it is run in,
which can differ from the one the background service was installed from.

## Local privacy controls

`PAIRFOB_QUOTA_PROVIDERS` is an optional comma-separated allowlist (for example
`codex,cursor`). Unset/empty keeps all sources; `none` disables all discovery.
Unknown names fail closed without querying providers. `service install` persists
this non-secret setting. Disabled providers are omitted from both quota responses;
no remote RPC fields or statuses change.

`pairfob quota authorize <claude|cursor|antigravity>` is a local-only action that
allows native Keychain interaction for up to two minutes and discards the returned
credential. A successful read does not promise a permanent grant: that depends on
the user's choice in macOS. Background reads pause after interaction is required
or declined. `pairfob quota retry <provider>` clears that pause through the local
admin socket after the user changes permissions. It does not read credentials or
show a prompt. The existing one-minute quota response cache still applies.

`pairfob doctor` reads `privacy.status` over the local admin socket: executable,
selected providers, native reader availability, and the last Keychain result per
provider (reason/time/paused). No credentials or raw provider errors are included.
These records are in memory; they do not survive a daemon restart. There is no
phone RPC to enable OS permission prompts. Builds without native Keychain support
return unavailable without falling back to `security` or AppleScript.

## Sources and refresh

- Codex: the local `codex app-server` using `initialize`, `account/read`, and
  `account/rateLimits/read`. No thread or turn is started. The multi-bucket
  `rateLimitsByLimitId` takes precedence over its single-bucket compatibility
  view. The provider call has an 8-second deadline and bounded output.
- Claude Code: automatic OAuth GET of `https://api.anthropic.com/api/oauth/usage`.
  Reads `CLAUDE_CONFIG_DIR/.credentials.json`, or the default macOS
  `Claude Code-credentials` file-based Keychain service through the native
  Security framework. Background reads disable user interaction. A read needing
  authorization is paused (`allow_keychain`; `auth_required` on the first
  operation); a timeout is `failed/timeout`, not a denial. No credential file and no Keychain item is
  `not_logged_in`. An expired credential is `auth_required`; one without the
  `user:profile` scope cannot read usage and is `unsupported`. A 403 from the
  endpoint is a network Anthropic does not serve, not a login to renew, and is
  `unavailable`. No login
  flow, refresh-token rotation, settings modification, or model turn occurs.
  Custom config directories currently require the credential file.
- GitHub Copilot: fixed `https://api.github.com/copilot_internal/user` query.
  Uses `COPILOT_GITHUB_TOKEN`, otherwise the unique public GitHub credential
  across Copilot hosts/apps files, then `gh auth token --hostname github.com`
  only when no Copilot token exists. Ambiguous accounts require explicit
  selection (`choose_account`; `auth_required` on the first operation): keep
  one GitHub.com login. No Copilot login and no `gh` login is `not_logged_in`.
  A `gh` token proves a GitHub login, not a Copilot subscription, so a refusal
  of one is `not_logged_in` rather than a login to renew. Enterprise tokens
  are never sent to github.com.
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
  account. On macOS, Pairfob queries the same file-based Keychain service/account
  through the native Security framework, with UI disabled for background reads.
  Pairfob now has its own Keychain access identity; an old grant to the security
  tool does not necessarily grant access to Pairfob. Reads have a three-second
  caller deadline and bounded returned data; at most one native call remains
  outstanding even if the caller times out. No background read unlocks the
  Keychain or changes its access rules. Missing credentials report
  `not_logged_in`; an expired or invalid login reports `auth_required`; an
  interaction-required read needs the user (`allow_keychain`; `auth_required`
  on the first operation). Timeouts report `failed/timeout`. The `memory`
  store is `unsupported`.
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
  two-second deadline; failure does not discard the quota. Expired or
  ambiguous credentials require `grok login`; no `auth.json`, or one with no
  x.ai login, is `not_logged_in`; an API key and non-User or missing principal
  types are unsupported.
  No CLI process, model turn, token refresh, or browser-cookie collection occurs.

- DeepSeek: reads `DEEPSEEK_API_KEY`, otherwise the key file
  `$PAIRFOB_STATE_DIR/deepseek.key` (default
  `~/.config/pairfob/deepseek.key`), then GETs
  `https://api.deepseek.com/user/balance`. `total_balance` becomes one
  `balance` meter in `cny` or `usd`; the balance is the spendable amount and is
  never converted to a share. `granted_balance` and `topped_up_balance` are
  parts of that amount, not separate allowances. `is_available` is required,
  and false is still a real balance rather than invented usage. An unknown
  currency or an amount that is not a two-decimal value is `unavailable`. A
  missing or unusable local key is `not_logged_in`. This provider is V2-only:
  the first operation keeps its six items. No model turn or credential write
  occurs.

- OpenCode Go: reads `OPENCODE_GO_API_KEY`, otherwise the login opencode keeps
  for itself — the `credential` rows of
  `$XDG_DATA_HOME/opencode/opencode.db` (default
  `~/.local/share/opencode/opencode.db`), read with a read-only `sqlite3`
  query, then the older `auth.json` beside it — otherwise the key file
  `$PAIRFOB_STATE_DIR/opencode-go.key` (default
  `~/.config/pairfob/opencode-go.key`). An OAuth login contributes its access
  token, an `api` login its key. The Go plan belongs to that account, so no
  second key is needed. It then GETs `https://opencode.ai/zen/go/v1/usage`.
  `usage.rolling` and `usage.weekly` become `five hour` (300 minutes) and
  `seven day` (10080) shares; `usage.monthly` is optional and becomes `monthly`
  with no window length. A percentage is what has been used, rounded to a
  tenth. A missing required window, a missing percentage or one outside 0-100
  is `unavailable`. 401 is `auth_required`; 403 is an authenticated account
  without the Go plan, reported as `unavailable` rather than a relogin. An
  expired token is renewed in opencode, never here. This provider is V2-only.
  No model turn or credential write occurs.

- Command Code: reads `COMMAND_CODE_API_KEY`, then `COMMANDCODE_API_KEY`,
  otherwise the login the `command-code` CLI writes to
  `~/.commandcode/auth.json` (`apiKey`), otherwise the key file
  `$PAIRFOB_STATE_DIR/command-code.key` (default
  `~/.config/pairfob/command-code.key`), then GETs
  `https://api.commandcode.ai/alpha/whoami`, `/alpha/billing/credits` and
  `/alpha/billing/subscriptions`, scoping the two billing reads to the `orgId`
  whoami names. `windowLimits.fiveHour` and `windowLimits.weekly` become
  `five hour` and `seven day` shares, carrying the dollars used and the cap as
  their counts; `monthlyCredits` with `purchasedCredits` and `freeCredits`
  becomes one `monthly balance` in `usd`, reset at the subscription's period
  end. A window that is present must carry both `used` and `cap`, a window with
  no cap is skipped, and `monthlyCredits` is required. Losing only the
  subscription read costs the plan name and the monthly reset, not the
  numbers. This provider is V2-only. No model turn, CLI process or credential
  write occurs.

Gemini CLI is deliberately excluded. Each provider represents the locally
selected account, not an aggregation of multiple login profiles. Provider
endpoints other than the Codex app-server are vendor-internal interfaces and
may change. Missing, rejected or unrecognized quota data is not a full allowance.
Remote requests reject redirects and have bounded responses and deadlines.

Each provider read has two steps. The first looks for the login on this
computer and makes no request to the provider; with nothing to ask it ends
there. Only a located login is read. HTTP reads run together, so a batch takes
as long as its slowest provider; reads that start a CLI (Codex today) share
three slots. The batch has a nine-second deadline.

The daemon caches each account's read for 60 seconds, on its own: one
provider's failure or age never decides another's. Concurrent refreshes, from
one phone or several and through either operation, share the read in flight
rather than starting another process or request. A provider that answers 429
is `throttled` and, when it sent `Retry-After`, is not asked again before then
(held to between one minute and one hour). Nothing is retried automatically.
Account-read failures produce a state and do not expose raw subprocess output.
The UI has an explicit refresh button and does not poll in the background.
A daemon that answers `unknown_op` to both operations is displayed as an
upgrade prompt.

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

The service installer preserves the nonsecret account-directory selectors
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `GROK_HOME`, and the explicit Claude
statusline source. Run `pairfob service install` from the configured shell after
changing these selectors; a restart alone does not change the stored environment.

## References

- [Codex app-server account reads](https://learn.chatgpt.com/docs/app-server)
- [Claude Code statusline fields](https://code.claude.com/docs/en/statusline)

- [Provider adapter reference](https://github.com/steipete/CodexBar/tree/main/Sources/CodexBarCore/Providers)
