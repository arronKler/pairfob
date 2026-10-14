---
title: Use cases
description: "Control Claude Code, Codex and Grok in Herdr from your phone: approvals, diffs, uploads, several computers, and when Pairfob is not a fit."
head:
  - - script
    - type: application/ld+json
    - "{\"@context\": \"https://schema.org\", \"@type\": \"FAQPage\", \"mainEntity\": [{\"@type\": \"Question\", \"name\": \"How do I control Claude Code from my phone?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Run Claude Code inside Herdr on a macOS or Linux computer, pair your phone once with Pairfob, and open the same live session in the phone's browser. No app or account is needed.\"}}, {\"@type\": \"Question\", \"name\": \"Can I answer Claude Code's approval prompts from my phone?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. When Claude Code shows a numbered approval list, Chat shows a Needs your confirmation card where you pick an option and tap Send choice.\"}}, {\"@type\": \"Question\", \"name\": \"How do I approve Codex CLI commands while away from my desk?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Run Codex in Herdr and pair your phone with Pairfob; a waiting Codex session is surfaced under Needs you, and its numbered approval prompt can be answered from the phone.\"}}, {\"@type\": \"Question\", \"name\": \"Can I review what Codex changed before I'm back at the computer?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Pairfob shows files, git status and diffs, and you can comment on diff lines and send those comments to the agent.\"}}, {\"@type\": \"Question\", \"name\": \"Can I use Grok CLI from my phone?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes, if Grok runs in Herdr. Chat view supports Grok sessions, and Control/Terminal work for any Herdr pane.\"}}, {\"@type\": \"Question\", \"name\": \"Do I need Tailscale, SSH, a VPN, or open ports?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"No. The computer only dials out to the pairfob.com relay, so nothing on it is reachable from the internet.\"}}, {\"@type\": \"Question\", \"name\": \"Is it peer-to-peer?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Partly. Sessions start through the relay and switch to a direct WebRTC connection when the network allows; the relay remains the fallback.\"}}, {\"@type\": \"Question\", \"name\": \"Can I send a photo or PDF from my phone to the agent?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Tap Add attachments, pick a file, photo or camera shot, and Pairfob inserts its workspace path into your draft.\"}}, {\"@type\": \"Question\", \"name\": \"Can one phone reach agents on several computers?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Pair each computer once and switch between them from the computer name at the top of the session list.\"}}, {\"@type\": \"Question\", \"name\": \"Does it work on a tablet?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. In a window 720px or wider the session list stays on the left with the session beside it.\"}}, {\"@type\": \"Question\", \"name\": \"When is Pairfob not a fit?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"When your agents don't run in Herdr, when the host computer is Windows, or when the computer can't stay awake and online while you are away.\"}}, {\"@type\": \"Question\", \"name\": \"Does it cost anything or need an account?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"No. Pairfob is free and open source (Apache-2.0), and there is no account or email login.\"}}]}"
---

# Use cases

Short answers to the questions people ask before trying Pairfob. Each answer comes first; the how-to follows.

**By agent:** Claude Code · Codex · Grok — then general questions and when Pairfob doesn't fit.

**Claude Code**

## How do I control Claude Code from my phone?

Run Claude Code inside Herdr on a macOS or Linux computer, pair your phone once with Pairfob, and open the same live session in the phone's browser. No app or account is needed.

1. Install Pairfob one of two ways. With the installer (Herdr 0.8 or newer): `curl -fsSL https://pairfob.com/install.sh | sh`, then `pairfob pair`. As a Herdr plugin (Herdr 0.8.2 or newer): `herdr plugin install arronKler/pairfob`, then run **Pairfob: Pair a device**.
2. On the phone, open [pairfob.com/pair](https://pairfob.com/pair) and scan the code, then press Enter on the computer to admit it. See [Get started](/start).
3. Open the session. **Chat** lets you message Claude and read replies; **Control** shows the terminal with a keypad.

## Can I answer Claude Code's approval prompts from my phone?

Yes. When Claude Code shows a numbered approval list, Chat shows a **Needs your confirmation** card where you pick an option and tap **Send choice**.

Before sending, the computer checks that the terminal screen has not changed; if it has, the card asks you to choose again. **Handle in terminal** switches to **Control** for anything else. See [Using the app](/app).

**Codex**

## How do I approve Codex CLI commands while away from my desk?

Run Codex in Herdr and pair your phone with Pairfob; a waiting Codex session is surfaced under **Needs you**, and its numbered approval prompt can be answered from the phone.

For alerts when the phone is locked, enable push on the computer (it is off by default); subscribed devices are notified when an agent needs you or finishes. See [Notifications](/push).

## Can I review what Codex changed before I'm back at the computer?

Yes. Pairfob shows files, git status and diffs, and you can comment on diff lines and send those comments to the agent.

Open the session, go to its changes, and add comments on the lines you want changed; send them as one message to the agent.

**Grok**

## Can I use Grok CLI from my phone?

Yes, if Grok runs in Herdr. Chat view supports Grok sessions, and Control/Terminal work for any Herdr pane.

Pair as above. Grok also appears in the subscription quota view when its account is signed in on the computer.

**General**

## Do I need Tailscale, SSH, a VPN, or open ports?

No. The computer only dials out to the pairfob.com relay, so nothing on it is reachable from the internet.

After pairing, the session is end-to-end encrypted; the relay forwards ciphertext it cannot read. When a direct path is found the session upgrades to a WebRTC DataChannel, otherwise it stays on the relay. See [What the relay cannot see](/security).

## Is it peer-to-peer?

Partly. Sessions start through the relay and switch to a direct WebRTC connection when the network allows; the relay remains the fallback.

File uploads need the direct connection; without it the app says **Uploads need a direct connection**.

## Can I send a photo or PDF from my phone to the agent?

Yes. Tap **Add attachments**, pick a file, photo or camera shot, and Pairfob inserts its workspace path into your draft.

Uploads run over the direct (P2P) connection. See [Upload attachments](/app#upload-attachments).

## Can one phone reach agents on several computers?

Yes. Pair each computer once and switch between them from the computer name at the top of the session list.

See [One phone, several computers](/devices#one-phone-several-computers).

## Does it work on a tablet?

Yes. In a window 720px or wider the session list stays on the left with the session beside it.

A touch tablet keeps swipes, long-press and the keypad; with a hardware keyboard, Enter sends.

**When it doesn't fit**

## When is Pairfob not a fit?

When your agents don't run in Herdr, when the host computer is Windows, or when the computer can't stay awake and online while you are away.

Pairfob does not run agents itself and cannot wake a sleeping computer. A Windows machine can still open pairfob.com/pair as a second screen, but the host must be macOS or Linux.

## Does it cost anything or need an account?

No. Pairfob is free and open source (Apache-2.0), and there is no account or email login.

Pairing is a one-time QR scan that you confirm on the computer; each device then keeps its own credential.
