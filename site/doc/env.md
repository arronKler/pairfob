---
title: Environment
description: Install, enroll, path roots, push. Do not set PAIRFOB_JOIN_TOKEN.
---

# Environment

Operator-facing variables only. Leave unspecified variables unset. Do not put secrets in a global `~/.zshrc` you then paste into logs.

## Enroll and origin

| Variable | When |
| --- | --- |
| `PAIRFOB_ORIGIN` | Default `https://pairfob.com`. Leave unset |
| `PAIRFOB_JOIN_TOKEN` | **Forbidden**. Setting it fails startup |

## Local state

| Variable | Default | Notes |
| --- | --- | --- |
| `PAIRFOB_STATE_DIR` | `~/.config/pairfob` | Identity, devices, logs |
| `PAIRFOB_ALLOWED_ROOTS` | user Home | Allowed roots for web paths. Setting it replaces Home |

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

The user service does not inherit your current shell. Write these into the service file, then `pairfob service restart`. See [Notifications](/push).

## Keep off

| Variable | Why |
| --- | --- |
| `PAIRFOB_HERDR_AUTOSTART` | `0` skips starting Herdr automatically |
| `PAIRFOB_DEV_FAKE_RUNTIME` | Demo data, not real Herdr |
| `PAIRFOB_DEV_AUTO_ADMIT` | Skips computer confirm. Outside isolated tests this hands the computer to anyone with the code |
