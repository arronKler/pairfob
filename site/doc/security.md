---
title: What the relay cannot see
description: After pairing, the session is encrypted. pairfob.com forwards messages and cannot see them. The computer only dials out.
---

# What the relay cannot see

`pairfob.com` is this project's official relay. It does not run Herdr and cannot see your code. After pairing, keys live only on your device and on the computer.

It cannot see the session, what you type, or the agent conversation. What it can see is only what it needs to reach the right computer, plus enough to rate-limit abuse.

## The computer only dials out

You do not open ports at home and you do not bind Tailscale. The computer connects out to `pairfob.com`.

Enter on the computer is what actually admits a device. Someone who only photographed the QR cannot pair.

## Where credentials live

| Place | What |
| --- | --- |
| Pairfob’s config directory on the computer | This computer’s identity and paired devices. Treat it as a password; do not paste it into chat |
| This device’s browser | This device’s credential. Clearing site data means pairing again |
| `pairfob.com` | Ids needed to route. No session contents |

## Out of scope

- A fake Pairfob page — use `https://pairfob.com`
- A stolen phone that is still paired
- Someone who already has the unlocked computer

## If something is wrong

1. `pairfob list` on the computer and `forget` anything that should not be there
2. If the computer itself is unclean: stop the service, clean the machine, reinstall

Do not paste pairing codes into someone else’s page.
