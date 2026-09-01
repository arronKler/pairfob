---
title: FAQ
description: Accounts, Herdr, lock screen, a closed lid, offline, a lost phone, Windows, cost, and how this differs from remote desktop.
---

# FAQ

## Do I need a Pairfob account?

No. There is no email login. The computer enrolls when you run the installer. Devices get a credential from pairing. Credentials live on the computer and in this browser.

## Can Pairfob run agents by itself?

No. It is the phone surface for [Herdr](https://herdr.dev). The computer needs Herdr 0.7 or newer installed. `pairfob` starts Herdr when needed. If automatic startup fails, the list shows Herdr offline and recovers after you run `herdr` manually.

## Is this remote desktop?

No. It does not stream pixels, move the mouse, or open your IDE window. It attaches to a session already open on the computer. See [The same screen](/model).

## Are phone capabilities the same as the computer?

They follow what the computer can do right now. Missing ones are not drawn and are not faked. The web surface also refuses a set of operations on purpose (arbitrary commands, deleting worktrees, stealing focus).

## When I open the phone on the road, is it a copy?

No. There is no “sync to phone”. Sitting down does not need a sync back. See [Leave and return](/continue).

## Does locking the screen or closing the lid still work?

Locking the screen is fine. Pairfob does not need the desktop unlocked. The login session, `pairfob`, and Herdr keep running behind the lock.

Closing the lid only works if the machine does **not** actually sleep. A laptop’s default lid-close is sleep: processes freeze, the network drops, and the phone shows **The computer is offline**. Pairfob cannot wake a sleeping computer, and it cannot unlock the machine.

To leave and keep using the phone:

- Lock the screen. Leave the lid open, or close it only if the machine will stay awake
- macOS: Control-Command-Q locks. Under Battery, stop automatic sleep when the display is off, at least on power. Lid closed plus power plus an external display is clamshell mode — the machine stays up
- Linux: in the desktop power settings, set lid close to do nothing or to lock
- A short keep-awake such as `caffeinate` on macOS is an OS command, not a Pairfob feature. Do not leave a closed lid in a bag while forcing the machine awake

When the computer wakes, `pairfob` reconnects by itself. You do not pair again. An asleep computer stays on the phone’s list; that is not unpaired. See [Leave and return](/continue).

## If the network drops, do I pair again?

No. The credential is still in the browser. It reconnects when the network returns. Pair again only after clearing site data, switching browsers, or `forget` on the computer.

## Windows?

`pairfob` does not install on Windows yet. A Windows machine can still open <a href="/pair">pairfob.com/pair</a> as a second screen. The host still has to be macOS or Linux.

## Tailscale / port forwarding?

No. `pairfob` only dials out. The home router does not need a Pairfob port.

## Can the relay see my code?

It cannot see the session, what you type, or the conversation. On a P2P path, pairfob.com still cannot see the session; the public-address lookup used to try a direct path sees this device’s public address. See [What the relay cannot see](/security).

## What if P2P cannot connect?

The session stays on Relay. In **Settings → Network path**, pin **Relay** to stop automatic direct attempts, or **Auto** to try again when a direct path is possible. If the site has P2P off, only Relay is available.

## Someone photographed the QR code.

Until you press Enter on the computer, they cannot pair. If you already pressed Enter and they show up in `pairfob list`, `forget` that row immediately. A used code is spent.

## I lost the phone.

`pairfob list` on the computer, then `pairfob forget N` for that row. Credentials on the phone are then useless. A lost phone can at most revoke itself, not your other devices.

## I cleared Safari data.

This device is unpaired. Run `pairfob pair` again. Other devices on the computer are unchanged.

## Can one phone talk to two computers?

Yes. Install pairfob on the other computer with the same command, run `pairfob pair` there, then **Settings → Add another computer**. The phone keeps both credentials and reconnects to the last one you used. Switch from **Computers** on the home screen. A computer that is offline stays on the list; that is not the same as unpaired. See [Multiple devices](/devices).

## Why 14 glyphs when typing?

8 glyphs are the secret and 6 only find your computer. Typing 8 alone is not sent. Scanning does not use those 6. See [Pairing](/pair).

## Can I reuse the install command?

Yes. Each computer runs `curl -fsSL https://pairfob.com/install.sh | sh` on its own. Then pair it from the phone: **Settings → Add another computer**. Update with `pairfob update`.

## Install failed on enroll.

Check the network and `pairfob doctor`. If this network has enrolled too many computers today, try again tomorrow. If setup is closed on the site, new computers cannot enroll right now; computers already set up keep working.

## The list is empty.

In order: `pairfob doctor` — is Herdr `on`? **Herdr is not running on the computer** means Herdr is closed; **No sessions yet** with a create hint means you are connected but there is no session yet. Did pairing finish (not still on the scan page)?

## Why is there no New / Split / Worktree?

The live Herdr does not support that yet. Upgrade and **restart the running Herdr**, not only install another CLI binary. With no agent kinds listed, **New** still opens a terminal pane.

## I tapped and I am not sure the computer did it.

Do not tap again. Look at the frame or refresh the list. Pairfob does not retry on its own.

## Notifications will not turn on.

They are off by default. Enable push on the computer, then `pairfob service restart`. Subscribe in **Settings → Notifications**. See [Notifications](/push).

## Can I let a coworker scan this code?

Do not treat the current code as a team invite. Pairing attaches to **your** computer’s Herdr. Every person / device should `pair` with you watching, and you press Enter. `forget` anyone who should not stay.

## Does it cost money?

No. The source is Apache-2.0 at <https://github.com/arronKler/pairfob>. `https://pairfob.com` is this project's official instance: the web app and the relay you enroll against. There is no account and no capacity promise.

New computer setup can close at any time. Computers already enrolled, and devices already paired, keep working.

## Is the documentation Chinese-only?

No. [Chinese docs](/zh/). The language menu in the docs top bar switches the docs. Pairfob (`/pair`) has its own control under **Settings → Language**. Both remember the same `pairfob_lang` preference.

## How do I report a problem?

Open a GitHub issue: <https://github.com/arronKler/pairfob/issues/new>

That is the public channel for bugs and product feedback. A security vulnerability goes to [GitHub Security Advisories](https://github.com/arronKler/pairfob/security/advisories/new), not a public issue.
