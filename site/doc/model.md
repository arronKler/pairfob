---
title: The same screen
description: Not a terminal emulator and not remote desktop. Reads the rendered pane and types back into the local PTY.
---

# The same screen

Pairfob does not draw xterm in the browser and is not remote desktop. It reads the pane the computer already rendered and sends keys back to the PTY. Both sides see one screen.

Herdr still runs on your computer. `pairfob.com` in the cloud is a relay. It does not run agents and does not parse session content.

```
tap / type / confirm                 the same pane
phone  ─────────────────────────►  Herdr on the computer
              ciphertext via the relay
```

## The product loop

The thing to preserve is not “a terminal on the phone”. It is this circle:

1. An agent is running on the computer
2. It stops and needs you (optional: a push)
3. You open **that** pane, not a generic home screen
4. Dialogs are tappable; Enter is not fired blindly
5. The system keyboard types into the local PTY
6. The frame confirms the change landed
7. You sit down at the computer on the same step

Capabilities the live coding-agent CLI has, Pairfob can show. Ones it does not have are not drawn. See [Where capabilities come from](/capabilities).

## So

- Opening the phone on the road is the computer’s session
- Sitting down needs no sync and no teardown of a remote window
- Layout changes on the phone are the computer’s layout
- There is no mobile-only command subset

This is not a mirrored copy. The phone window and the computer window are the same one.

## Compared with common setups

| | Pairfob | Browser terminal | Remote desktop | Hosted agent |
| --- | --- | --- | --- | --- |
| Where the session lives | Your computer | Often a new session | The whole desktop | Someone else’s machine |
| What you see | Rendered pane | A new terminal buffer | Pixels | Another chat |
| Merge on return | No | Often yes | Two places you acted | Two contexts |
| Open ports at home | No | Depends | Common | No |
| CLI capabilities | Live Herdr | Whatever you type into a PTY | Full desktop, too heavy | The product’s own subset |

## Deliberately absent

- No ANSI interpreter, no curses emulation in the browser
- Herdr HTTP / Unix sockets are not exposed to the relay
- No second agent runtime on the phone
- Focus is not stolen back to the computer foreground
- No arbitrary commands, worktree deletion, or full layout overlay

Paths and cwd must land in a live snapshot root or `PAIRFOB_ALLOWED_ROOTS`. Failures are fail-closed; Pairfob does not guess a successful path.
