---
title: Multiple devices
description: Pair another device with a new code. A phone can revoke only itself; use forget on the computer for others.
---

# Multiple devices

The computer is one side. Phones, tablets, and other browsers can pair into the same herd. Each device holds its own credential. You cannot clone a pairing by exporting browser data.

The device list stores a coarse label (for example `iPhone` or `Android 手机`), last-used time, and notification subscription count. It does not store PSKs, User-Agent strings, or push endpoints.

## Add another

On the computer:

```sh
pairfobd pair
```

Scan with the **new** device (or type this printout’s 14 glyphs). Do not scan again from a device that is already paired — that opens a new pairing slot and invalidates whoever else was using the current slot.

The cap is **10** established session connections per daemon, plus a short recovery window. A handful of phones is enough. When the cap is hit, a new device fails until you `forget` one.

## Who is connected

```sh
pairfobd list
```

```
1  iPhone  just now
2  Android 手机  2 hours ago

Unpair one: pairfobd forget 1
```

If nothing is paired: `Nothing paired yet. Pair one: pairfobd pair`.

The phone **设置** page also lists devices and marks the current one as **这台手机**.

## Revoke

On the computer, use the `list` index:

```sh
pairfobd forget 1
```

`pairfobd forget iPhone` works when the name is unique. Collisions require the index.

On the phone, **设置 → 危险操作 → 解除这台手机的配对** can only drop **itself**. That is intentional: a lost phone that can still open Pairfob can at most kick itself, not the rest of the household. The phone also mentions `pairfobd device revoke <device_id>`; `forget N` from `list` is the usual computer path.

To drop a phone you can no longer hold:

1. `pairfobd list` on the computer
2. `pairfobd forget N`
3. Local credentials on that device become useless; opening Pairfob requires pairing again

## Lost or sold phone

1. `forget` the row on the computer immediately
2. If push was on, those subscriptions die with it
3. If the computer itself may be compromised, consider `pairfobd relay rekey` and re-pair every device — [What the relay cannot see](/security)

## One phone, several computers

Each computer enrolls and pairs on its own. Same installer, new pairing:

1. On the other computer: `curl -fsSL https://pairfob.com/install.sh | sh`
2. There: `pairfobd pair`
3. On this phone: **设置 → 添加另一台电脑**, then scan that computer’s current code

The phone keeps one credential per computer and reconnects to the last one you used. Home shows **电脑** when more than one credential is stored. **切换电脑** is on the same **连接** card.

A computer that is asleep or offline stays on the list. Pairfob does not delete that credential, and it does not send you back to the scan page. Wake it; you do not pair again. A locked screen is fine; a closed lid only works if the machine does not sleep.

**忘记** on a row only drops the credential in this browser. The computer still lists this device until you `forget` it there. **解除这台手机的配对** still only affects the current computer pairing.

## Another window

A second Pairfob page on the same paired phone may tell the old window that another window took over. Distinct **devices** can stay connected together; multiple windows of one device steal the session.
