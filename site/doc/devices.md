---
title: Multiple devices
description: Pair another device with a new code. Settings can unpair others; the computer can also forget.
---

# Multiple devices

The computer is one side. Phones, tablets, and other browsers can pair into the same herd. Each device holds its own credential. You cannot clone a pairing by exporting browser data.

## Add another

On the computer:

```sh
pairfob pair
```

Scan with the **new** device (or type this printout’s 14 glyphs). Do not scan again from a device that is already paired — that opens a new pairing and invalidates whoever else was using the current code.

A handful of phones is enough. When the cap is hit, a new device fails until you `forget` one.

## Who is connected

```sh
pairfob list
```

```
1  iPhone  just now
2  Android phone  2 hours ago

Unpair one: pairfob forget 1
```

If nothing is paired: `Nothing paired yet. Pair one: pairfob pair`.

The phone **Settings** page also lists devices: the current row is **This phone**, others show online or offline. Already unpaired rows are omitted.

## Revoke

On the phone, **Settings → Paired devices** has **Unpair** on every other row. That device disconnects immediately and must scan again. **Danger zone → Unpair this phone** still only drops this device.

On the computer, use the `list` index:

```sh
pairfob forget 1
```

`pairfob forget iPhone` works when the name is unique. Collisions require the index.

To drop a phone you can no longer hold, prefer the computer:

1. `pairfob list` on the computer
2. `pairfob forget N`
3. Local credentials on that device become useless; opening Pairfob requires pairing again

## Lost or sold phone

1. `forget` the row on the computer immediately
2. If push was on, those subscriptions die with it
3. If the computer itself may be compromised, see [What the relay cannot see](/security)

## One phone, several computers

Each computer enrolls and pairs on its own. Same installer, new pairing:

1. On the other computer: `curl -fsSL https://pairfob.com/install.sh | sh`
2. There: `pairfob pair`
3. On this phone: **Settings → Add another computer**, then scan that computer’s current code

The phone keeps one credential per computer and reconnects to the last one you used. Home shows **Computers** when more than one credential is stored.

A computer that is asleep or offline stays on the list. Pairfob does not delete that credential, and it does not send you back to the scan page. Wake it; you do not pair again. A locked screen is fine; a closed lid only works if the machine does not sleep.

**Forget** on a row only drops the credential in this browser. The computer still lists this device until you `forget` it there or **Unpair** it under Settings → Paired devices. **Unpair this phone** still only affects the current computer pairing.

## Machines Herdr reaches over SSH

If Herdr on a paired computer has saved SSH machines (`herdr machine add`), the phone can add each one without a pairing code.

1. Connect to that computer and open **Computers**
2. Under **Machines … reaches**, tap **Add** on a machine
3. If Pairfob is missing there, confirm **Install**. The computer installs and starts it over its own SSH connection

The machine then joins the computer list and you connect to it like any other computer. It keeps its own identity and keys; the first computer only relays a one-use pairing link and is not needed afterwards.

What to expect:

- One tap per machine, and each phone adds machines for itself
- The computer must reach the machine with `ssh` that needs no password or prompt
- Machines run Linux or macOS and use Herdr's default session
- Both the computer and the machine need Pairfob 1.3.0 or later. Update the computer with `pairfob update`

From the computer's terminal, `pairfob machine list` shows the same machines and `pairfob machine link NAME` prints that machine's pairing code here.

## Another window

A second Pairfob page on the same paired phone may tell the old window that another window took over. Distinct **devices** can stay connected together; multiple windows of one device steal the session.
