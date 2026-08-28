---
title: Install
description: install.sh downloads pairfobd, verifies checksums, enrolls, and installs a login service.
---

# Install

Hosted install pulls binaries from `https://pairfob.com/dl` (override with `PAIRFOB_DOWNLOAD_BASE`). `curl` is required. macOS and Linux, amd64 or arm64. Windows is rejected.

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

The same command on a second computer. Then pair it from the phone: **设置 → 添加另一台电脑**. Do not set `PAIRFOB_JOIN_TOKEN`.

## What the script does

1. Reads `uname -s` / `uname -m` and picks a name like `pairfobd-darwin-arm64`
2. Downloads the binary and `SHA256SUMS`, hashes locally
3. Mismatch → exit, no overwrite
4. Installs the binary into the prefix (table below)
5. Enrolls and writes the reconnect credential into the state directory
6. Unless `--no-service`, installs a **user-level** login service (no root daemon)

## Flags

| Flag | Role |
| --- | --- |
| `--origin URL` | Default `https://pairfob.com`. Leave it |
| `--prefix DIR` | Install directory. Root or a writable `/usr/local/bin` uses that; otherwise `~/.local/bin` |
| `--no-service` | Binary and enroll only; no login service |
| `--no-enroll` | Binary only. Tests and air-gapped copies |

Also valid:

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --prefix "$HOME/bin"
```

Environment:

| Variable | Role |
| --- | --- |
| `PAIRFOB_DOWNLOAD_BASE` | Download root, default `https://pairfob.com/dl` |
| `PAIRFOB_INSTALL_PREFIX` | Default for `--prefix` |

Machines that already enrolled: rerunning the installer refreshes the binary and leaves `relay.json` alone.

## Where it lands

| Condition | Binary |
| --- | --- |
| Root, or writable `/usr/local/bin` | `$PREFIX/pairfobd`, default `/usr/local/bin/pairfobd` |
| Ordinary user | Default `~/.local/bin/pairfobd` |

If `~/.local/bin` is not on `PATH`, the script tells you to add it. For zsh:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## After install

- User service
  - macOS: `~/Library/LaunchAgents/com.pairfob.pairfobd.plist`, label `com.pairfob.pairfobd`
  - Linux: `~/.config/systemd/user/pairfobd.service`
- Logs: `~/.config/pairfob/pairfobd.log` (or under `PAIRFOB_STATE_DIR`)
- State directory default `~/.config/pairfob`, directory mode `0700`, files `0600`
- Identity, reconnect, device list, optional push keys. Back this up as **credentials**. Do not commit it

After a login, the service starts on its own. It is a login service, not a boot daemon: sleep and logout stop it; coming back to the same graphical session starts it again. In the current graphical session you can run `pairfobd` in a terminal, or:

```sh
pairfobd service status
pairfobd service restart
```

Day to day you should not need those. `pairfobd update` replaces the binary and restarts an installed user service.

## Update

```sh
pairfobd update
```

Pulls artifacts from this origin’s `/dl`, verifies checksums, replaces the binary in place, restarts the user service. Do not rerun the installer as an “update”.

## Uninstall

```sh
pairfobd service uninstall
rm -f "$(command -v pairfobd)"
```

Uninstalling the service does not delete the state directory. To drop pairings too, remove `~/.config/pairfob` after you are sure you do not need those device credentials.

## Already enrolled

Successful enroll leaves `relay.json`. Later starts reuse it.

## From source

Useful when changing the protocol or comparing locally. Herdr still needs to be installed; `pairfobd` starts the default single-session server when it launches.

```sh
go run ./cmd/pairfobd
```

`PAIRFOB_ORIGIN` defaults to `https://pairfob.com`. Do not also set `PAIRFOB_JOIN_TOKEN`.

## Compatibility

`--grant jg_…` and `PAIRFOB_JOIN_GRANT` still enroll against an already-minted grant. The product path does not use them.
