---
title: Troubleshooting
description: Herdr closed, sleep, a closed lid, locator missing, devices out of sync. Start with pairfob doctor.
---

# Troubleshooting

On the computer first:

```sh
pairfob doctor
```

Service:

```sh
pairfob service status
```

## Sentences in the UI

Match the English Pairfob string on screen:

| You see | Do this first |
| --- | --- |
| The computer is offline | Sleep, a closed lid, a dropped network, or `pairfob` not running. Wake the computer; you do not pair again. Then `pairfob doctor` |
| Herdr is not running on the computer | The machine is up, but Herdr quit. Open Herdr; Pairfob recovers automatically |
| No sessions yet | Connected, but there is no session yet — create one or open a terminal on the computer |
| Enter the full pairing code shown on the computer | Hand entry is 8+6 glyphs |
| The pairing code is not complete: 14 glyphs needed | Include the locator |
| That pairing code is spent or expired | `pairfob pair` again on the computer |
| That pairing code is incorrect | Use the code being printed now; do not edit the old one |
| Too many attempts | Wait; do not loop |
| This Herdr version cannot do that yet | Computer Herdr, not a missing phone button |
| The computer may already have run that action | Do not double-tap; look at the frame |
| That session is gone | Back to the list |
| Another window took over this phone | Keep a single Pairfob page |
| Could not read site config / Could not reach this site | Network or wrong page |
| Another computer started pairing | Slot stolen; `pair` on the computer you mean |
| P2P is temporarily unavailable. Relay remains active | Direct path failed; the session stayed on Relay. To stop retries, set Network path to **Relay** |
| P2P is unavailable on this site | This site has direct paths off; only Relay is available |

## doctor

| Output | Action |
| --- | --- |
| Running no | `pairfob` or `pairfob service restart` |
| Herdr off | Automatic startup did not complete. Confirm Herdr 0.7+ is installed, run `herdr` |
| Origin … not set up | Rerun the installer |
| Paired 0 | `pairfob pair` |
| P2P off | This computer is relay-only (`PAIRFOB_P2P=0`) |

## Install and enroll

- Do not set `PAIRFOB_JOIN_TOKEN` or `PAIRFOB_JOIN_GRANT`
- Checksum mismatch: the script fails closed
- Unsupported OS (Windows): the script refuses
- If `~/.local/bin` is not on PATH, `pairfob` is “not found” even when the service is installed

## Pairing

- Use the code in the **current** terminal, not a screenshot
- Hand entry is 14 glyphs; missing the locator means the request is not sent
- Scan failures: camera permission, or type instead
- The computer must still be waiting in `pairfob pair`; Ctrl-C means open a new slot
- Two computers running `pair` at once steal the slot from each other

## Network path

- Default **Auto**: Relay first, then P2P when a direct path exists; a failed upgrade does not drop the session
- Switching Wi-Fi or coming back online probes immediately and resets the P2P retry timer
- Settings shows why the last direct attempt failed while the session stays on Relay
- Direct path keeps failing: Settings → Network path → **Relay**
- To try a direct path again: **Auto**, or **P2P** for one immediate attempt
- **Relay** pauses automatic P2P retries in this browser
- Pairfob does not run TURN; a strict NAT stays on Relay
- If an existing P2P path loses ICE, the session drops back to Relay without disconnecting, then retries the upgrade

## Connected but cannot act

- Still on the scan page means not paired
- If Herdr quit, an open session fails; open Herdr first
- Missing buttons: upgrade and restart the **running** Herdr
- Path rejected: outside the directories the computer allows

## Sleep, lock, lid

- Locked screen, machine still up: should work. Pairfob does not need the desktop unlocked
- Closed lid / sleep: the phone shows **The computer is offline**. Open the lid or wake it. Do not pair again; the computer stays on the list
- Herdr quit while the machine is awake: **Herdr is not running on the computer**
- Pairfob cannot wake a sleeping computer. Details: [FAQ](/faq)

## Still stuck

Keep the full `pairfob doctor` output. Do not paste pairing codes.
