---
title: Environment
description: Install, enroll, path roots, push. Do not set PAIRFOB_JOIN_TOKEN.
---

# Environment

Operator-facing variables only. Changing these does not invent another RPC, and it does not relax path checks.

Leave unspecified variables unset. Do not put secrets in a global `~/.zshrc` you then paste into logs.

## Enroll and origin

| Variable | When |
| --- | --- |
| `PAIRFOB_ORIGIN` | HTTPS origin. Default `https://pairfob.com`. Leave unset |
| `PAIRFOB_RELAY_WS` | Rare WebSocket URL override. Prefer unset |
| `PAIRFOB_JOIN_TOKEN` | **Forbidden**. Setting it fails startup |
| `PAIRFOB_JOIN_GRANT` | Unused on the product path. The installer enrolls without it |

## Local state

| Variable | Default | Notes |
| --- | --- | --- |
| `PAIRFOB_STATE_DIR` | `~/.config/pairfob` | Identity, reconnect, devices, logs, socket. Directory `0700` |
| `PAIRFOB_ADMIN_SOCK` | `$PAIRFOB_STATE_DIR/pairfobd.sock` | Local admin socket; must be an absolute path |
| `PAIRFOB_ALLOWED_ROOTS` | user Home | Allowed roots for web paths. Setting it replaces Home; empty leaves only Herdr roots. Unix uses `:` |

## Install

| Variable | Notes |
| --- | --- |
| `PAIRFOB_DOWNLOAD_BASE` | Binary download root, default `https://pairfob.com/dl` |
| `PAIRFOB_INSTALL_PREFIX` | Same as `install.sh --prefix` |

## Push

| Variable | Notes |
| --- | --- |
| `PAIRFOB_PUSH` | `1` enables. Off by default |
| `PAIRFOB_VAPID_SUBJECT` | A `mailto:` or `https:` URL you control |

The user service does not inherit your current shell. For LaunchAgent / systemd to see these, write them into the service file, then `pairfobd service restart`. See [Notifications](/push).

## Keep off

| Variable | Why |
| --- | --- |
| `PAIRFOB_MULTI_SESSION` | Off by default. Only if you intentionally discover multiple Herdr session sockets |
| `PAIRFOB_DEV_FAKE_RUNTIME` | Demo data, not real Herdr |
| `PAIRFOB_DEV_AUTO_ADMIT` | Skips computer confirm. Outside isolated tests this hands the computer to anyone with the code |
| `PAIRFOB_PAIR_CODE` | Opens a slot at process start, for automation |
| `PAIRFOB_PROTOCOL` | If set, must be `2`. Prefer unset |

## Do not invent

Do not add a friendlier aggregate switch, and do not put a client-claimed `device_id` in the environment as an admit ticket. Capabilities are the eleven live `GetConfig.capabilities` keys — [Where capabilities come from](/capabilities).
