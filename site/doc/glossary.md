---
title: Glossary
description: What Herdr, pane, pairfob, and locator mean in Pairfob.
---

# Glossary

| Term | Meaning |
| --- | --- |
| Herdr | Local program that runs coding agents on the computer. Pairfob does not replace it. Needs 0.7 or newer |
| pane | One already-open session surface |
| 控制 | Phone UI for that pane: tappable choices, system keyboard. Default mode |
| 终端 | A real terminal. For vim or a full-screen TUI |
| 对话 | Message the Agent. Collapsible run |
| pairfob | Pairfob background process on this computer. Outbound only. Talks to local Herdr only |
| pairing code | 8 glyphs, secret |
| locator | 6 glyphs, only finds that computer, not the same class of secret |
| Computer confirm | After the other device proves the code, one Enter on the computer admits it |
| relay | `pairfob.com`, this project's official instance. Forwards ciphertext, does not read the session |
| PWA | The Pairfob page in the browser; can be added to the Home Screen. Path `/pair` |
| `PAIRFOB_STATE_DIR` | Default `~/.config/pairfob`, credentials and device list |
| worktree | Git worktree. List / create / open follow the computer |
