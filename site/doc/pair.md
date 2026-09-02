---
title: Pairing
description: Scan or type a code. After the computer confirms, the device may read and write.
---

# Pairing

Pairing is **authorization**, not an account login. Pairfob has no username, email, or cloud account. Until it completes, the device cannot operate. After the computer confirms, this device holds a credential.

The credential stays in **this browser on this device**. Another browser, cleared site data, removing the PWA, or a private window means pairing again.

## Opening pairing on the computer

On the computer that already runs `pairfob`:

```sh
pairfob pair
```

It will:

1. Prefer a QR code
2. Also print a manual code
3. Wait for the other device to prove the pairing secret
4. Ask for one Enter

There is no web confirm page. Do not look for an “Accept pairing” button in another machine’s browser — accept happens in this computer’s terminal.

::: warning Only one pairing at a time
If another computer also runs `pairfob pair`, the old code dies. The phone may say another computer started pairing, or that the code expired. Use the code **this** computer just printed.
:::

## Connecting the other device

Open <a href="/pair">pairfob.com/pair</a>. The pairing page follows the same language as Pairfob (**Connect your computer** in English). A device that is already paired goes straight to the session list.

### Scan (preferred) — **Scan to connect**

Point the camera at the QR on the computer. Camera permission is only for that scan.

### Type it — **Can't scan? Type the pairing code**

Typing needs **8 secret glyphs + 6 locator glyphs**. There is no 8-glyph-only hand entry.

- One field; paste all 14 glyphs (spaces and hyphens allowed; `O` → `0`, `I`/`L` → `1`)
- Eight glyphs only: the page asks for the rest and **does not send**

The two parts are different jobs:

| Part | Length | Job |
| --- | ---: | --- |
| Pairing code | 8 | Secret. Proves you saw the computer screen |
| Locator | 6 | Finds that computer. Not the same class of secret |

## Enter on the computer

**Only Enter on the computer actually admits the device.** After the phone scans it still waits. Neither side shows security words. That stops a screenshot of the QR from pairing without you.

If it is not your device, refuse on the computer (Ctrl-C or wait for expiry) and run `pairfob pair` again.

## Expired or wrong codes

A code is **spent when used**, and it also expires. Do not use a code from chat or last week’s screenshot.

Match the string on screen (English Pairfob):

| You see | Meaning | Do this |
| --- | --- | --- |
| That pairing code is spent or expired | Slot rotated, or the code is dead | Use the code the computer is **printing now** |
| Enter the full pairing code / 14 glyphs needed | Locator missing | Paste 8+6 together |
| That pairing code is incorrect | Does not match | New code; do not permute the old one |
| Pairing timed out | Network, or the computer left the wait | Scan or type the current code again |
| Too many attempts | This side is rate-limited | Wait |
| Another computer started pairing | A newer `pair` took the slot | Open pairing on the computer you mean to use |

## After pairing

- Opening <a href="/pair">pairfob.com/pair</a> reconnects to the last computer this browser used
- Another computer on this phone: install pairfob there with the same command, run `pairfob pair`, then **Settings → Add another computer** — [Multiple devices](/devices)
- Another device: run `pairfob pair` again and scan with the **new** device — [Multiple devices](/devices)
- On the phone, **Settings → Paired devices** can unpair other devices. The computer can also `pairfob forget N`

## Do not

- Paste pairing codes into someone else’s page or a group chat
- Clone a paired browser profile onto another phone
- Assume pairing finished before the computer confirmed
- Keep using an old code while two computers have pairing open
