---
title: Computer commands
description: pair, list, forget, doctor, update. After install it runs in the background; type pairfobd for status.
---

# Computer commands

After install, Pairfob runs in the background. Typing `pairfobd` with no subcommand prints status: running or not, how many devices, whether Herdr is open.

```
Pairfob is running.
1 device paired.
Herdr is on.

  pairfobd pair     pair a device
  pairfobd list     what's paired
  pairfobd doctor   full check
```

If it is not running: it starts at login after install, or run `pairfobd` in this terminal. Sleep and logout stop the login service until you are back in that session.

## Daily commands

```sh
pairfobd pair      # pair a phone, tablet, or another computer
pairfobd list      # paired devices
pairfobd forget 1  # unpair #1 (index from list)
pairfobd doctor    # local checklist
pairfobd update    # latest binary and restart the user service
pairfobd version
pairfobd help
```

`pair`, `list`, and `forget` talk to the live process over `$PAIRFOB_STATE_DIR/pairfobd.sock` (mode `0600`). The socket accepts the same user only. There is no local HTTP admin UI.

`forget` also accepts a device name; collisions require the index. `unpair` is an alias of `forget`.

## doctor

```
Pairfob <version>

  Running     yes
  Paired      1
  Herdr       on
  Origin      pairfob.com
```

| Field | Healthy | When it is not |
| --- | --- | --- |
| Running | yes | Login service did not start. See `~/.config/pairfob/pairfobd.log` or `pairfobd service status` |
| Paired | ≥ 1 | Nothing paired yet. Run `pairfobd pair` |
| Herdr | on | `off — open Herdr on this computer` |
| Origin | `pairfob.com` | Not enrolled, or protocol mismatch |

`doctor` exits non-zero when Running or Herdr is unhealthy, so scripts can branch on it.

## Service

The installer puts a user service in place. When you need to touch it:

```sh
pairfobd service status
pairfobd service restart
pairfobd service stop
pairfobd service start
pairfobd service uninstall
pairfobd service install
```

- macOS: LaunchAgent `com.pairfob.pairfobd`
- Linux: systemd --user `pairfobd.service`

Push environment variables are not written into the service file automatically. See [Notifications](/push).

## Update

```sh
pairfobd update
```

Pulls the binary from this origin’s `/dl`, verifies SHA-256, replaces itself, restarts an installed user service. Do not rerun `install.sh` to update.

## Advanced (omitted from default help)

Still available for automation and debugging:

| Command | Use |
| --- | --- |
| `pairfobd pair new` | Open a slot and print the code; no interactive confirm |
| `pairfobd pair status` | JSON for the current slot |
| `pairfobd pair accept` / `deny` | Confirm or refuse without Enter |
| `pairfobd enroll` | Retry enroll. The installer already does this |
| `pairfobd relay rekey` | Rotate the reconnect credential |
| `pairfobd device revoke <id>` | Revoke by device id (`forget N` is the usual path) |

`PAIRFOB_PAIR_CODE` opens a pairing slot at process start, for automation only. Do not set it in a normal login environment.
`PAIRFOB_DEV_AUTO_ADMIT=1` skips the computer confirm. **Only in isolated automated tests.**
