---
title: Computer commands
description: pair, list, forget, doctor, update. After install it runs in the background; type pairfob for status.
---

# Computer commands

After install, Pairfob runs in the background. Typing `pairfob` with no subcommand prints status: running or not, how many devices, whether Herdr is open.

```
Pairfob is running.
1 device paired.
Herdr is on.

  pairfob pair     pair a device
  pairfob list     what's paired
  pairfob doctor   full check
```

If it is not running: it starts at login after install, or run `pairfob` in this terminal. Sleep and logout stop the login service until you are back in that session.

## Daily commands

```sh
pairfob pair      # pair a phone, tablet, or another computer
pairfob list      # paired devices
pairfob forget 1  # unpair #1 (index from list)
pairfob doctor    # local checklist
pairfob update    # latest binary and restart the user service
pairfob version
pairfob help
```

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
| Running | yes | Login service did not start. See `pairfob service status` |
| Paired | ≥ 1 | Nothing paired yet. Run `pairfob pair` |
| Herdr | on | `off — open Herdr on this computer` |
| Origin | `pairfob.com` | Not enrolled |

`doctor` exits non-zero when Running or Herdr is unhealthy, so scripts can branch on it.

## Service

The installer puts a user service in place. When you need to touch it:

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

Replaces the binary and restarts an installed user service. Do not rerun `install.sh` to update.

## Advanced (omitted from default help)

Still available for automation and debugging:

| Command | Use |
| --- | --- |
| `pairfob pair new` | Open pairing and print the code; no interactive confirm |
| `pairfob pair accept` / `deny` | Confirm or refuse without Enter |
| `pairfob enroll` | Retry enroll. The installer already does this |
| `pairfob relay rekey` | Rotate the reconnect credential |
| `pairfob device revoke <id>` | Revoke by device id (`forget N` is the usual path) |
