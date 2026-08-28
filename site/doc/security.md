---
title: What the relay cannot see
description: After pairing, the session is end-to-end encrypted. The relay forwards ciphertext. The computer only dials out.
---

# What the relay cannot see

`pairfob.com` is a relay, not a VPN, and it does not run Herdr. After pairing, session keys live only on your device and in `pairfobd` on the computer.

## What the relay sees / does not see

| Cannot see | Can see (routing and rate limits) |
| --- | --- |
| Pane text | Internal routing ids (which daemon, which connection) |
| Keystrokes | Ciphertext length |
| RPC payloads | Whether pairing is being hammered |
| Device keys, PSKs | Source IP (`CF-Connecting-IP` for limits) |
| The Herdr socket | Outcomes such as enroll / pairing success |

The relay forwards frames. It does not parse `FWD` plaintext and does not implement the Herdr API.

The envelope label is `pairfob.v1`. Go and the browser are checked against the same test vectors. “Close enough” encodings are not allowed.

## The computer only dials out

`pairfobd` connects outbound. You do not open ports at home and you do not bind Tailscale. Identity is admitted only on the daemon:

- A client-claimed `device_id` is not enough to authorize
- Herdr HTTP or Unix sockets are not exposed to the relay
- Reads and writes both require an `Established` session

## Why confirm is on the computer

After the other device proves the code, Enter on the computer is what actually admits it. That stops someone who only has the QR from pairing without you. The product does not show security words.

Neither scan nor typed entry puts the pairing secret on a URL query string as a long-lived token. The locator only finds the computer; it never enters SPAKE2+.

## Where credentials live

| Place | What |
| --- | --- |
| Computer `~/.config/pairfob` | Daemon identity, reconnect, devices, operation ledger, optional VAPID. Directory `0700`, files `0600` |
| This device’s browser storage | This device’s session credential. Clearing site data means pairing again |
| `pairfob.com` | Opaque ids needed to route. No pane plaintext |

Back up the state directory as sensitive credentials. Do not commit it. Do not paste it into chat.

Enroll is not an account password. Pairing and reconnect stay on this computer and this browser.

## Out of scope

Pairfob does not claim to stop:

- A modified front-end (a fake Pairfob page) — use `https://pairfob.com`
- A stolen phone whose browser storage was not cleared and whose pairing was not revoked
- Someone who can read Herdr or `~/.config/pairfob` on the computer
- Someone already at your unlocked computer terminal who presses Enter for you

## If something is wrong

1. `pairfobd list` on the computer and `forget` anything that should not be there
2. If reconnect material may have leaked: `pairfobd relay rekey`, then pair every device again
3. If the computer itself is unclean: treat Herdr and local keys as exposed, stop the service, clean the machine, reinstall

Do not paste pairing codes, `relay.json`, or `vapid.json` into someone else’s page.
