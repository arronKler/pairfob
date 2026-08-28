---
title: Leave and return
description: Work still running on the computer is the same session on the phone. Sitting down again needs no sync.
---

# Leave and return

This is the loop Pairfob is built to keep: start on the computer, continue on the road, sit down at the same step.

Agents keep running on the computer. Pairfob only attaches another paired device to that screen. There is no “sync to phone” or “sync back to desktop”, and no primary/secondary switch.

## At the desk

Use Herdr as usual. You do not open Pairfob first, and you do not mark a session as remote. If `pairfobd` is running (it usually starts at login after install), a paired device can attach at any time.

The Herdr window on the computer is already the primary. The phone is another pane of glass on the same screen.

## Leaving in a hurry

1. Herdr and `pairfobd` keep running on the computer
2. Lock the screen if you want — Pairfob does not need it unlocked
3. Leave the lid open, or close it only if the machine will stay awake
4. Open Pairfob (browser or Home Screen PWA)
5. Open the session you were in

Confirms, typing, and worktrees go back to the machine. If [notifications](/push) are on, needs-you and completion pushes open that session on the correct computer, not only the home list.

The lock screen is not the problem. Sleep is. Closing the lid in a bag is not a Pairfob scenario: the phone cannot attach, and Pairfob cannot power the machine back on. When the computer wakes, it reconnects without a new pairing. Lock versus lid: [FAQ](/faq).

## Sitting down again

Dialogs you just tapped, layout you just changed, and text you just typed are already on the computer. You do not:

- Tap “sync to desktop”
- Tear down a remote session
- Re-open the same agent window as the “primary”
- Copy a phone draft back

Both sides were the same pane. Sit down and look at Herdr.

## A brief dropout

The WebSocket reconnects. The credential is still in this browser; you do not scan again. After reconnect the list and the frame follow the computer’s current state. Queued keystrokes from while you were offline are not replayed.

If `pairfobd` restarts on the computer, paired devices remain valid (credentials live in the state directory), but an in-flight pairing slot is void.

## Several devices at once

A tablet or another computer’s browser can pair the same way. What you see and can operate matches the phone, and matches the CLI on the computer. Several attachments still share one herd.

Two windows of the **same** phone steal from each other — [Using the app](/app#another-window). Distinct devices do not elect a primary. They are the same screen.

## Versus “remote dev”

| Remote desktop / SSH terminal | Pairfob |
| --- | --- |
| Another session or the whole desktop | The Herdr pane already running |
| Two states to merge when you return | One state when you return |
| Often needs open ports or an overlay | Computer dials out only |
| Keys travel inside a remote protocol | System keyboard → local PTY |
