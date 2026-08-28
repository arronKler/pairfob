# Security

Report vulnerabilities privately through GitHub Security Advisories:

https://github.com/arronKler/pairfob/security/advisories/new

Do not open a public issue for a security report.

## Secrets that never belong in git

`OPERATOR_TOKEN` and `IP_HASH_PEPPER` for pairfob.com live in the Cloudflare
dashboard, not this repository. Local files that stay gitignored:

- `workers/pairfob-origin/.dev.vars`
- `workers/pairfob-origin/.prod-operator-token`
- `.dev/` (pairing state, reconnect tokens, local TLS keys)
- `log/`

A clone cannot enroll into production without those dashboard secrets and a
Cloudflare login on the pairfob.com account. Keep account 2FA on. Do not put
wrangler API tokens in the repo or in plaintext CI.
