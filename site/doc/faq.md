---
title: FAQ
description: Accounts, Herdr, lock screen, a closed lid, offline, a lost phone, Windows, and how this differs from remote desktop.
---

# FAQ

## Do I need a Pairfob account?

No. There is no email login. The computer enrolls when you run the installer. Devices get a credential from pairing. Credentials live in the computer’s state directory and in this browser.

## Can Pairfob run agents by itself?

No. It is the phone surface for [Herdr](https://herdr.dev). The computer needs Herdr 0.7 or newer installed. In the default single-session setup, `pairfobd` starts the persistent Herdr server when needed. If automatic startup fails, the list shows Herdr offline and recovers after you run `herdr` manually.

## Is this remote desktop?

No. It does not stream pixels, move the mouse, or open your IDE window. It attaches to a pane Herdr already rendered and types into the local PTY. See [The same screen](/model).

## Are phone capabilities the same as the computer?

They follow the **live** Herdr. Controls appear only for what that CLI can do right now; missing ones are not drawn and are not faked. The web surface also refuses a set of operations on purpose (arbitrary commands, deleting worktrees, stealing focus). See [Where capabilities come from](/capabilities).

## When I open the phone on the road, is it a copy?

No. There is no “sync to phone”. Sitting down does not need a sync back. See [Leave and return](/continue).

## Does locking the screen or closing the lid still work?

Locking the screen is fine. Pairfob does not need the desktop unlocked. The login session, `pairfobd`, Herdr, and the outbound path to `pairfob.com` keep running behind the lock.

Closing the lid only works if the machine does **not** actually sleep. A laptop’s default lid-close is sleep: processes freeze, the network drops, and the phone shows **电脑现在不在线**. Pairfob cannot wake a sleeping computer, and it cannot unlock the machine.

To leave and keep using the phone:

- Lock the screen. Leave the lid open, or close it only if the machine will stay awake
- macOS: Control-Command-Q locks. Under Battery, stop automatic sleep when the display is off, at least on power. Lid closed plus power plus an external display is clamshell mode — the machine stays up
- Linux: in the desktop power settings, set lid close to do nothing or to lock
- A short keep-awake such as `caffeinate` on macOS is an OS command, not a Pairfob feature. Do not leave a closed lid in a bag while forcing the machine awake

When the computer wakes, `pairfobd` reconnects by itself. You do not pair again. An asleep computer stays on the phone’s list; that is not unpaired. See [Leave and return](/continue).

## If the network drops, do I pair again?

No. The credential is still in the browser. It reconnects when the network returns. Pair again only after clearing site data, switching browsers, or `forget` on the computer.

## Windows?

`pairfobd` does not install on Windows yet. A Windows machine can still open <a href="/pair">pairfob.com/pair</a> as a second screen. The host still has to be macOS or Linux.

## Tailscale / port forwarding?

No. `pairfobd` only dials out. The home router does not need a Pairfob port.

## Can the relay see my code?

It cannot see pane text, keystrokes, or RPC payloads. It can see routing ids, ciphertext length, and the IP used for rate limits. See [What the relay cannot see](/security).

## Someone photographed the QR code.

Until you press Enter on the computer, they cannot pair. If you already pressed Enter and they show up in `pairfobd list`, `forget` that row immediately. A used code is spent.

## I lost the phone.

`pairfobd list` on the computer, then `pairfobd forget N` for that row. Credentials on the phone are then useless. A lost phone can at most revoke itself, not your other devices.

## I cleared Safari data.

This device is unpaired. Run `pairfobd pair` again. Other devices on the computer are unchanged.

## Can one phone talk to two computers?

Yes. Install pairfobd on the other computer with the same command, run `pairfobd pair` there, then **设置 → 添加另一台电脑**. The phone keeps both credentials and reconnects to the last one you used. Switch from **电脑** on the home screen. A computer that is offline stays on the list; that is not the same as unpaired. See [Multiple devices](/devices).

## Why 14 glyphs when typing?

8 glyphs are the secret and 6 only find your computer. Typing 8 alone is not sent. Scanning does not use those 6. See [Pairing](/pair).

## Can I reuse the install command?

Yes. Each computer runs `curl -fsSL https://pairfob.com/install.sh | sh` on its own. Then pair it from the phone: **设置 → 添加另一台电脑**. An enrolled machine reconnects with `relay.json`. Update with `pairfobd update`.

## Install failed on enroll.

Check the network and `pairfobd doctor`. Do not set `PAIRFOB_JOIN_TOKEN`. If this network has enrolled too many computers today, try again tomorrow.

## The list is empty.

In order: `pairfobd doctor` — is Herdr `on`? The empty title **还没有读到会话** means Herdr is closed; **还没有会话** means you are connected but there is no pane yet. Did pairing finish (not still on the scan page)?

## Why is there no 新建 / 分屏 / Worktree?

The live Herdr did not declare that capability. Upgrade and **restart the running Herdr server**, not only install another CLI binary. Empty `agent_kinds` still allows **新建** as a terminal pane. If **铺满全屏** is missing, the session menu says the live Herdr cannot fill a split pane.

## I tapped and I am not sure the computer did it.

Do not tap again. If you see that the computer might already have applied the operation, look at the frame or refresh the list. Pairfob does not auto-retry mutations.

## Notifications will not turn on.

They are off by default. Set `PAIRFOB_PUSH=1` and a valid `PAIRFOB_VAPID_SUBJECT` in the user service environment, then `pairfobd service restart`. Subscribe in **设置 → 通知**. See [Notifications](/push).

## Can I let a coworker scan this code?

Do not treat the current code as a team invite. Pairing attaches to **your** computer’s Herdr. Every person / device should `pair` with you watching, and you press Enter. `forget` anyone who should not stay.

## Can one phone attach to two computers?

Yes. One browser profile can keep a separate pairing credential for each computer. Use **设置 → 添加另一台电脑** and scan the second computer's current QR code. Each computer is still paired separately, and one `pairfobd` still talks to only one origin.

## Does it cost money?

The entry and the web app are meant to be usable as they stand. This page does not promise a capacity SLA. Concurrent-connection numbers in the design are a target, not a guarantee for your personal session.

## Is the documentation Chinese-only?

No. [中文文档](/zh/). Use the language menu in the top bar.
