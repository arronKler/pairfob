---
title: Install
description: install.sh downloads pairfob, verifies checksums, enrolls, and installs a login service.
---

# Install

Install pulls binaries from this project's official instance at `https://pairfob.com/dl`. `curl` is required. macOS and Linux. Windows is rejected.

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

The same command on a second computer. Then pair it from the phone: **设置 → 添加另一台电脑**. Do not set `PAIRFOB_JOIN_TOKEN`.

## What the script does

1. Downloads the `pairfob` binary for this OS
2. Verifies the checksum and refuses to overwrite on mismatch
3. Enrolls
4. Unless `--no-service`, installs a **user-level** login service

## Flags

| Flag | Role |
| --- | --- |
| `--prefix DIR` | Install directory. A writable `/usr/local/bin` uses that; otherwise `~/.local/bin` |
| `--no-service` | Binary and enroll only; no login service |
| `--no-enroll` | Binary only. Tests and air-gapped copies |

Also valid:

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --prefix "$HOME/bin"
```

Machines that already enrolled: rerunning the installer refreshes the binary and leaves existing pairings alone.

## Where it lands

| Condition | Binary |
| --- | --- |
| Writable `/usr/local/bin` | Default `/usr/local/bin/pairfob` |
| Ordinary user | Default `~/.local/bin/pairfob` |

`pairfob` is the command shown in this documentation. The installer also creates
`pairfobd → pairfob` in the same directory as a compatibility alias.

If `~/.local/bin` is not on `PATH`, the script tells you to add it. For zsh:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## After install

After a login, the service starts on its own. It is a login service, not a boot daemon: sleep and logout stop it; coming back to the same graphical session starts it again. In the current graphical session you can run `pairfob` in a terminal, or:

```sh
pairfob service status
pairfob service restart
```

Day to day you should not need those. `pairfob update` replaces the binary and restarts an installed user service.

## Update

```sh
pairfob update
```

Replaces the binary and restarts the user service. Do not rerun the installer as an “update”.

## Uninstall

```sh
pairfob service uninstall
prefix="$(dirname "$(command -v pairfob)")"
rm -f "$prefix/pairfob" "$prefix/pairfobd"
```

Uninstalling the service does not delete the state directory. To drop pairings too, remove `~/.config/pairfob` after you are sure you do not need those device credentials.

## From source

Clone [the repository](https://github.com/arronKler/pairfob) for local comparison. Herdr still needs to be installed. Everyday use still follows the install command above.

```sh
go run ./cmd/pairfob
```

Local pairing and checks are in the repository README.
