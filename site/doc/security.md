---
title: What the relay cannot see
description: The relay forwards ciphertext; the browser client still trusts code supplied by the official site. Understand the limits of end-to-end encryption.
---

# What the relay cannot see

`pairfob.com` is this project's official relay. It does not run Herdr. Provided the devices and client code have not been tampered with, the session is end-to-end encrypted after pairing, and keys live only on your device and on the computer.

The relay forwards ciphertext and cannot see the session, what you type, or the agent conversation. It can see the identifiers needed to reach the right computer and the connection source used to rate-limit abuse.

On a P2P path, session bytes do not go through `pairfob.com`; the relay still only sees the ciphertext used to set up that path. To find a direct path, the browser asks Cloudflare’s public-address lookup, which sees this device’s public address. Pairfob does not run a bypass for firewalls; if a direct path cannot be found, the session stays on the relay.

## Trust in the website's code

The browser's encryption and decryption code comes from `pairfob.com`, so you still need to trust the official site and its code publishing channel. If the site operator or someone who controls that channel serves malicious code, it could read and send out keys or plaintext. End-to-end encryption cannot protect a client that has been tampered with.

Adding the PWA to your Home Screen still allows updates from the site; it does not pin a trusted version. The guarantees about the relay's access to session contents depend on trusted devices and client code.

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

- Malicious control of the official website's code or publishing channel
- A fake Pairfob page — use `https://pairfob.com`
- A stolen phone that is still paired
- Someone who already has the unlocked computer

## If something is wrong

1. `pairfob list` on the computer and `forget` anything that should not be there
2. If the computer itself is unclean: stop the service, clean the machine, reinstall

Do not paste pairing codes into someone else’s page.
