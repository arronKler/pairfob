---
title: Computer commands
description: pair, list, forget, doctor, update. After install it runs in the background; type pairfob for status.
---

# Computer commands

After install, Pairfob runs in the background. Typing `pairfob` with no subcommand in a terminal prints status and exits: running or not, how many devices, whether Herdr is open. If it is not running, the command prints recovery advice and exits non-zero.

```
Pairfob is running.
1 device paired.
Herdr is on.

  pairfob pair     pair a device
  pairfob list     what's paired
  pairfob doctor   full check
```

If it is not running, follow the suggested service command, or use `pairfob run` for foreground use. Sleep and logout stop the login service until you are back in that session.

## Daily commands

```sh
pairfob pair      # pair a phone, tablet, or another computer
pairfob list      # paired devices
pairfob forget 1  # unpair #1 (index from list)
pairfob doctor    # local checklist
pairfob run       # foreground daemon
pairfob update    # latest binary and restart the user service
pairfob version
pairfob help
```

`forget` also accepts a device name; collisions require the index. `unpair` is an alias of `forget`.

`pairfob machine list` shows the SSH machines Herdr has saved on this computer, and `pairfob machine link NAME` pairs a device with one of them. See [Machines Herdr reaches over SSH](/devices).


## setup

`pairfob setup` checks and starts Herdr when needed, asking before installing a missing dependency. `pairfob setup --install-herdr --non-interactive` explicitly permits installation without prompting. Existing Herdr installations are not upgraded or replaced. `doctor` remains read-only.

## doctor

```
Pairfob <version>

  Installed   <version>
  Process     <version> (PID 1234)
  Running     yes
  Paired      1
  Herdr       ready (0.8.2, protocol 20)
  P2P         on
  Origin      pairfob.com
```

| Field | Healthy | When it is not |
| --- | --- | --- |
| Running | yes | `service not installed` → `pairfob service install`; `service stopped` → `pairfob service start`; `service running but not answering` → `pairfob service restart`; status unavailable → `pairfob service status` |
| Paired | ≥ 1 | Nothing paired yet. Run `pairfob pair` |
| Herdr | `ready` | `not installed` / `installed but not running` / `incompatible server` / `unavailable` |
| P2P | `on` | `off` means this computer is relay-only (`PAIRFOB_P2P=0`); `unknown` clears after a restart |
| Origin | `pairfob.com` | Not enrolled |

`doctor` exits non-zero when Running or Herdr is unhealthy, so scripts can branch on it.

`Installed` describes this command's version; `Process` describes the daemon answering local requests. A mismatch calls for `pairfob service restart`. Very old daemons cannot report their actual version; the phone shows it as unknown instead of treating the old `0.1.0` placeholder as a release.

## Service

The installer puts a user service in place. `doctor` and the not-running status suggest the matching install, start, restart, or status command without changing the service. For foreground use, run `pairfob run`. Typing `pairfob` in a terminal only shows status; login services still start the daemon the same way as before. When you need to touch the service:

```sh
pairfob service status
pairfob service restart
pairfob service stop
pairfob service start
pairfob service uninstall
pairfob service install
```

Push environment variables are not written into the service file automatically. See [Notifications](/push).

## Update

```sh
pairfob update
```

Replaces the binary and restarts an installed user service. Do not rerun `install.sh` to update. Hosted binaries use SemVer (`pairfob version`); the site build stamp is separate.

Even when the file is already current, the command verifies the responding daemon's version and image against the user service's PID. Install and restart also wait for the matching daemon to stay ready before reporting success. An independent old daemon is stopped only when its user, executable and state directory can be verified; otherwise the command identifies the conflict for manual resolution. Pairings are preserved.

Downloads report bytes received and retry once after a transient failure. Each attempt allows ten minutes total, with a 45-second limit without progress. SHA-256 verification still runs before replacement. If a proxy repeatedly stalls, inspect the terminal's proxy configuration; the updater does not change it.

The phone checks for new computer versions and shows an update reminder. In Settings, supported service-managed installations offer **Update computer**. Confirming briefly disconnects the phone while the verified binary starts; completion is shown only after the running version is confirmed. Failed startup can restore the previous binary. Older daemons require one manual `pairfob update` to enable this flow. Updates are never installed automatically.


## Advanced (omitted from default help)

Still available for automation and debugging:

| Command | Use |
| --- | --- |
| `pairfob pair new` | Open pairing and print the code; no interactive confirm |
| `pairfob pair accept` / `deny` | Confirm or refuse without Enter |
| `pairfob enroll` | Retry enroll. The installer already does this |
| `pairfob relay rekey` | Rotate the reconnect credential |
| `pairfob device revoke <id>` | Revoke by device id (`forget N` is the usual path) |
