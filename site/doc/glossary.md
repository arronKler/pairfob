---
title: Glossary
description: What Herdr, pane, pairfobd, and locator mean in Pairfob.
---

# Glossary

| Term | Meaning |
| --- | --- |
| Herdr | Local program that runs coding agents on the computer. Pairfob does not replace it. Needs 0.7 or newer |
| pane | One already-rendered session surface |
| 控制 | Phone UI for that pane: tappable choices, system keyboard into the PTY. Default mode |
| 终端 | A real terminal (xterm). For vim or a full-screen TUI |
| 对话 | Message the Agent. Collapsible run, Markdown reply |
| PTY | The pseudoterminal that receives keys on the computer. Phone keystrokes land here |
| pairfobd | Pairfob background process on this computer. Outbound only. Talks to local Herdr only |
| join token / `PAIRFOB_JOIN_TOKEN` | Removed. Do not set it |
| origin | The HTTPS host for the web app and WebSocket. Hosted is `https://pairfob.com` |
| pairing code | 8 glyphs, secret, used in pairing crypto |
| locator | 6 glyphs, only finds that computer, not the same class of secret |
| Computer confirm | After the other device proves the code, one Enter on the computer admits it |
| relay | The Worker at `pairfob.com`. Forwards ciphertext, does not read the pane |
| PWA | The Pairfob page in the browser; can be added to the Home Screen. Path `/pair` |
| Established | Session state after pairing and confirm. Reads and writes both require it |
| `PAIRFOB_STATE_DIR` | Default `~/.config/pairfob`, credentials and device list |
| operation_id | Fresh id for each mutation. Not a retry token |
| `unknown_outcome` | The computer may or may not have applied it. Refresh, do not replay |
| capabilities | Eleven independent booleans that decide which controls are drawn |
| worktree | Git worktree. List / create / open follow live Herdr |
| VAPID | Web Push key pair. Not created until push is enabled |
