---
title: Install
description: install.sh downloads pairfob, verifies checksums, enrolls, and installs a login service.
---

# Install

Install pulls binaries from this project's official instance at `https://dl.pairfob.com/daemon`. `curl` is required. macOS and Linux. Windows is rejected.

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

The same command on a second computer. Then pair it from the phone: **Settings → Switch computer → Add a computer**. Do not set `PAIRFOB_JOIN_TOKEN`.

Pairfob does not install or sign in to AI agents. Install and sign in to your chosen agent on the computer before using it, or choose Terminal after pairing to work without an agent.

## Herdr checks and installation

Before replacing Pairfob, enrolling, or installing its service, the installer checks Herdr. It reuses a ready server, starts an installed server when needed, and waits for its API. If Herdr is missing, it automatically installs the latest stable release into `~/.local/bin/herdr`, verifies SHA-256 and records its source. Existing installations are preserved.

For unattended installation, use the following command; missing Herdr is still installed automatically:

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --non-interactive
```

`--non-interactive` never prompts and still installs missing Herdr by default. Use `--no-install-herdr` to fail instead when Herdr is missing. `--skip-herdr-check` installs Pairfob without claiming session readiness. `--no-service` still checks Herdr; for offline preparation use `--no-service --no-enroll --skip-herdr-check`.

Later, run `pairfob setup` to check and start Herdr, or `pairfob setup --install-herdr` to install a missing dependency. `pairfob doctor` only diagnoses; it never installs or starts anything. Incompatible protocols, startup failures, and invalid `HERDR_BIN` or socket settings must be resolved before continuing. Existing Herdr sessions are never automatically upgraded or restarted. Pairfob starts only the default server; with `PAIRFOB_HERDR_AUTOSTART=0`, start the configured Herdr server yourself. See [Named Herdr sessions](/app#named-herdr-sessions) for the autostart limits.

## What the script does

1. Downloads the `pairfob` binary for this OS
2. Verifies the checksum and refuses to overwrite on mismatch
3. Checks Herdr, automatically installs the latest stable release if missing, starts it if needed, and verifies its API
4. Enrolls
5. Unless `--no-service`, installs a **user-level** login service

## Flags

| Flag | Role |
| --- | --- |
| `--prefix DIR` | Install directory. A writable `/usr/local/bin` uses that; otherwise `~/.local/bin` |
| `--no-service` | Binary and enroll only; no login service |
| `--no-enroll` | Skip enrollment; service and Herdr checks still apply |
| `--no-install-herdr` | Fail instead of installing missing Herdr |
| `--install-herdr` | Compatibility alias: install missing Herdr (the default) |
| `--non-interactive` | Never prompt; install missing Herdr unless explicitly disabled |
| `--skip-herdr-check` | Skip Herdr checks without claiming session readiness |

Also valid:

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --prefix "$HOME/bin"
```

Machines that already enrolled: rerunning the installer refreshes the binary and leaves existing pairings alone.

The service retains the checked Herdr executable, socket, configuration paths, and startup options so a different login PATH does not break the connection.

The installer checks and starts Herdr from the home directory, matching the login service. Relative Herdr configuration paths are also interpreted from home.

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

After a login, the service starts on its own. It is a login service, not a boot daemon: sleep and logout stop it; coming back to the same graphical session starts it again. In a terminal, `pairfob` shows status and suggests the appropriate recovery command. Use `pairfob run` for foreground use. To inspect or restart the installed service:

```sh
pairfob service status
pairfob service restart
```

Day to day you should not need those. `pairfob update` replaces the binary and restarts an installed user service.

## Access your Mac desktop while away

On macOS 13 or later, the interactive installer offers to set up remote desktop. On an existing installation, or if you chose **Set Up Later**, run `pairfob desktop setup` on the Mac. Choose the display and either **Allow View Only** or **Allow View & Control**. Grant Screen Recording when macOS asks. Keyboard and mouse control also require Accessibility. Before leaving, run `pairfob desktop status` to check the P2P setting, system permissions, lock state and display. A direct connection also depends on the networks in use when the phone connects.

Open **Remote desktop** on the computer's details page on your paired phone. Your choice applies to current and future paired devices. They can reconnect without anyone confirming on the Mac while it is awake, unlocked and reachable over P2P. Stopping a stream ends that session. To turn off future access, run `pairfob desktop disable` on the Mac.

If you leave your Mac plugged in, run `pairfob desktop standby-on` after granting desktop access to prevent idle system sleep on external power. Unplugging it or running `pairfob desktop standby-off` releases the request. The display can still sleep. When the system is awake and your account is unlocked, opening a remote session requests a wake for the selected sleeping display. Automatic locking still applies. For sleep, a locked account or the first login after a restart, set up a [recovery console](./mac-recovery).

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

Clone [the repository](https://github.com/arronKler/pairfob) for local comparison. Run setup once to prepare Herdr automatically. Everyday use still follows the install command above.

```sh
go run ./cmd/pairfob setup
go run ./cmd/pairfob
```

Local pairing and checks are in the repository README.

<span id="herdr-runtime"></span>

## Update the Herdr runtime

`pairfob update` and **Update to v…** in the browser update Pairfob only. For Herdr installed and still managed by Pairfob, run:

```sh
pairfob setup --update-herdr
```

With running sessions, this only downloads and verifies the update. Exit code 2 means prepared but not active; tasks keep running. When tasks can be interrupted, run on that computer:

```sh
pairfob setup --update-herdr --restart-herdr
```

The command describes the target and impact and asks in the terminal before stopping the default service, updating and verifying. Stopping terminates terminal processes; agents may need recovery. Restoring a binary cannot restore those processes. Named sessions, custom sockets and externally supervised servers need local maintenance using their original setup. Non-interactive mode cannot authorize a restart.

Update Homebrew, mise, Nix or unknown installations through their original installer. Older Pairfob installs without provenance are not adopted automatically. `pairfob doctor` reports installed and running versions and pending updates. Uninstalling Pairfob keeps Herdr, sessions and projects.
