---
title: Get started
description: Install Herdr and pairfob once, then continue from another device.
---

# Get started

This project's official instance is `https://pairfob.com`. Herdr must be able to run on the computer. macOS and Linux are supported; Windows is not yet.

Four steps: install Herdr → install Pairfob → pair → open a session.

## What you need

| Need | Notes |
| --- | --- |
| A macOS or Linux computer | `pairfob` and the agents run here |
| [Herdr](https://herdr.dev) 0.7 or newer | Pairfob does not ship an agent and does not replace Herdr |
| `curl` | The install script downloads the binary |
| A browser on another device | Phone, tablet, or another computer |

## 1. Herdr is installed on the computer

Pairfob does not replace Herdr. Agents still run here, but Herdr does not need to be open before Pairfob starts. When `pairfob` launches and finds Herdr offline, it starts it. Running `herdr` later attaches to that same server, so the sessions already opened from the phone are not copies.

If automatic startup fails, the phone explicitly says Herdr is not running. Run `herdr` once on the computer and Pairfob recovers without a restart or new pairing. There is no extra “remote mode” to turn on.

## 2. Install pairfob

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

This downloads `pairfob`, enrolls with the official instance at `https://pairfob.com`, and installs a user-level login service.

The service starts after you log in, not at power-on. Sleeping with the lid closed, or logging out, stops it until you return to that same session.

A second computer uses the same command, then **Settings → Add another computer** on the phone.

Flags, install paths, and uninstall: [Install](/install).

After install, type `pairfob` with no subcommand. It prints whether it is running, how many devices are paired, and whether Herdr is open. For the full checklist use `pairfob doctor`.

## 3. Pair

On a terminal **on the computer that runs pairfob**:

```sh
pairfob pair
```

It leads with a QR code and keeps a manual code as fallback. On the other device open <a href="/pair">pairfob.com/pair</a>:

- **Can scan:** scan and pairing starts
- **Cannot scan:** type the code. That is **8 pairing glyphs + 6 locator glyphs** (you can paste all 14)

After the other side proves the code, press **Enter** once in the computer terminal. This is authorization, not an account login. Neither side shows security words.

Details and errors: [Pairing](/pair).

## 4. Open a session

Herdr sessions appear in the Pairfob list. Tapping a card opens that session on the computer, not a copy.

When the status is **Needs you**, choices become tappable buttons. Pairfob **does not blindly send Enter**. The compose box uses the system keyboard, including dictation and autocorrect. What you send lands in that session on the computer.

UI: [Using the app](/app). Leaving and sitting down: [Leave and return](/continue).

## Add to Home Screen

Pairfob is a web app. Pinning it removes the browser chrome.

**iOS / iPadOS (Safari)**

1. Open <a href="/pair">pairfob.com/pair</a> (after pairing this goes straight to the list)
2. Share → Add to Home Screen
3. Open from the icon next time

iOS is meant to run from the Home Screen. A Safari tab still works; notifications and full screen are weaker.

**Android (Chrome)**

Chrome may offer “Install app”, or use the menu → Install app / Add to Home Screen.

The credential lives in **this browser profile on this device**. Another browser, cleared site data, or a private tab means pairing again.

## What success looks like

| On the computer | On the phone |
| --- | --- |
| `pairfob doctor` shows Running / Herdr / Origin healthy | Opening Pairfob shows the same session list |
| `pairfob list` includes this device | Opening a **Needs you** card, the dialog is tappable |
| The Herdr window is still there | Typed text appears in that computer session |

Next: [Multiple devices](/devices), [Notifications](/push), or skim the [FAQ](/faq).
