# Self-hosted relay

This page is for operators who want to run the Pairfob relay on their own
Cloudflare account. It is not part of the public site documentation:
`https://pairfob.com` remains the official instance, and the web app,
installer and docs it serves describe that instance.

The relay routes encrypted frames. It never sees the plaintext inside `FWD`,
and pairing, identity and keys stay on the daemons. Running your own relay in
another Cloudflare account does not change the protocol: envelope bytes remain
`pairfob.v1` and the mux subprotocol remains `pairfob.v2`.

## What the deployer creates

One command deploys, in the Cloudflare account Wrangler is logged in to:

| Resource | Name |
| --- | --- |
| Worker | `pairfob-relay` (or `--name`) |
| Workers Assets | the PWA plus the installer, served from the same Worker |
| Durable Objects | `DaemonRoom` and `PairingIndex` (SQLite classes) |
| D1 database | `pairfob-relay-db`, with `workers/pairfob-origin/migrations` applied |
| Worker secrets | `OPERATOR_TOKEN` and `IP_HASH_PEPPER` |

The Worker serves the web app at `/pair` and a small landing page at `/`.
Serving the app from the relay matters: in a browser, the PWA always uses its
own page origin as the relay origin. Loading the app from `pairfob.com` cannot
point it at another relay.

Generated state lives in `.dev/selfhost/<name>/` (ignored by git):

- `wrangler.json` — the deploy config with absolute paths into this checkout
- `secrets.env` — mode `0600`, uploaded with each deploy
- `public/` — the packed static assets

Re-running the deployer is safe: it finds the D1 database by name, keeps the
existing secrets, retains the previous PWA asset generation for open tabs, and
redeploys the same Worker.

## Requirements

- Bun and the two lockfiles:

  ```sh
  (cd pwa && bun install --frozen-lockfile)
  (cd workers/pairfob-origin && bun install --frozen-lockfile)
  ```

- Wrangler authenticated against the target account, either with
  `wrangler login` or `CLOUDFLARE_API_TOKEN`. The token needs Workers Scripts,
  Workers Durable Objects, Workers Assets and D1 edit permissions.
- A registered `workers.dev` subdomain for the account, unless you pass
  `--domain`. Without either, the Worker has no public URL.
- A Cloudflare zone for a custom domain, if you use `--domain`.

## Deploy

```sh
bun scripts/selfhost-relay.ts
```

The command builds the PWA, packs the relay assets, creates the D1 database,
applies migrations, deploys the Worker, and checks `/v2/health`,
`/api/config` and `/pair` on the deployed origin. It prints the relay URL, the
web app URL and the commands to pair or install a computer.

Useful options:

| Option | Effect |
| --- | --- |
| `--name NAME` | Worker and database prefix (`pairfob-relay` by default) |
| `--domain relay.example.com` | Serve on a custom domain with automatic TLS |
| `--origin URL` | Expected relay origin, or use when Wrangler prints none. A custom host also needs `--domain` |
| `--database-id ID` | Reuse an existing D1 database instead of creating one |
| `--state-dir DIR` | Keep generated state somewhere other than `.dev/selfhost/<name>` |
| `--skip-build` | Use the existing `pwa/dist` |
| `--no-smoke` | Skip the post-deploy checks |
| `--rotate-secrets` | Generate a new operator token and IP hash pepper |
| `--dry-run` | Build, pack and validate the config without creating anything |

A dry run uses a placeholder D1 id and only runs `wrangler deploy --dry-run`,
so it does not touch the account:

```sh
bun scripts/selfhost-relay.ts --dry-run --skip-build
```

Set `PAIRFOB_WRANGLER` to use a specific Wrangler binary. Without it the
deployer uses `workers/pairfob-origin/node_modules/.bin/wrangler`, then
`wrangler` on `PATH`.

## Pair a computer

Use the printed commands, or:

```sh
pairfob enroll --origin https://<relay-host>
curl -fsSL https://<relay-host>/install.sh | sh -s -- --origin https://<relay-host>
```

The relay's `install.sh` downloads daemon artifacts from
`https://dl.pairfob.com/daemon`, the same signed channel the official
installer uses. Set `PAIRFOB_DOWNLOAD_BASE` to use another mirror. The daemon
auto-updater also reads `https://dl.pairfob.com/daemon/VERSION`; a self-hosted
relay does not change where daemon binaries come from.

The installer also reads `PAIRFOB_ORIGIN` when `--origin` is absent, so
`PAIRFOB_ORIGIN=https://<relay-host> sh install.sh` works without repeating the
flag.

Native Android and iOS release builds are compiled against the official
origin, and the hosted browser app cannot be repointed. The web app served by
the relay at `/pair` is the supported client for a self-hosted relay: it names
its own host in the install command, the connection path and the connection
copy, and it enrolls new computers against that host.

A self-hosted relay serves only `pairfob.v2`. Native builds and any older
daemon that would ask for `/v1/ws` are refused by the relay, so pair a computer
with this checkout's daemon or a current release.

## Security and operations

- Enrollment is open and rate-limited per client IP (`SELF_GRANT_PER_IP` in
  `workers/pairfob-origin/src/constants.ts`). Treat the relay URL as public.
- `OPERATOR_TOKEN` guards `/v2/admin/*`. It is generated once and kept in
  `secrets.env`; rotate it with `--rotate-secrets` if it leaks.
- `IP_HASH_PEPPER` keys the per-IP hashes used by enrollment limits. Keep it
  stable across redeploys; rotating it resets the per-IP accounting.
- The relay is frame-level: the Durable Object forwards opaque `FWD` frames
  and does not parse session content. Do not expose the daemon's Herdr socket
  or add a plaintext inspection path to the relay.
- The generated config omits Analytics Engine. Add a `METRICS` binding
  manually if you want the Worker's counters.

## Upgrade

Pull the checkout and rerun the deployer. It applies any new D1 migrations
before deploying, keeps the existing secrets and D1 database, and retains the
previous PWA asset generation so open tabs can still load their chunks.

## Remove

```sh
# From the repository root; uses the generated config.
(cd workers/pairfob-origin && bunx wrangler delete --config ../../.dev/selfhost/<name>/wrangler.json)

# D1 is not removed with the Worker.
(cd workers/pairfob-origin && bunx wrangler d1 delete <name>-db)

rm -rf .dev/selfhost/<name>
```

Deleting the Worker also deletes its Durable Object storage. Export anything
you need from D1 first.
