---
title: Where capabilities come from
description: Controls follow the live Herdr server. Eleven independent booleans; no aggregate aliases.
---

# Where capabilities come from

Pairfob does not invent a mobile-only command set. New conversation, splits, worktrees, and the rest follow the **running** Herdr on the computer.

A newer installed CLI does not make an older Herdr server capable. Unsupported operations fail before a mutation (the UI talks about the current Herdr version) instead of being sent and then erroring.

## Eleven switches

Authority is eleven booleans on one config read. All eleven are always present and independent. There are no aggregate `worktrees` or `layout` switches. One missing flag does not hide a sibling that is supported.

| Key | What the UI means |
| --- | --- |
| `create_conversation` | New conversation |
| `create_tab` | Add a tab |
| `split_pane` | Split |
| `prompt_agent` | Prompt a detected agent |
| `history` | Trusted conversation and bounded rendered-terminal history, both collected on the computer |
| `list_worktrees` | List worktrees |
| `create_worktree` | Create a worktree |
| `open_worktree` | Open a worktree |
| `resize_pane` | Make this pane a bit larger |
| `swap_pane` | Swap with the neighboring pane |
| `zoom_pane` | Fill the computer window (un-split / re-split) |

Agent kinds also come from the live server (`agent_kinds`). The phone does not hard-code “Codex / Claude / Grok”. Those kinds are only the picker for starting an agent. **新建** stays available whenever `create_conversation` is true; omitting a kind creates a terminal pane.

## Paths

A path or cwd submitted from the web must land in:

- a workspace / pane root from the current live snapshot, or
- an allowed local root `PAIRFOB_ALLOWED_ROOTS`

Rules:

- **Unset** `PAIRFOB_ALLOWED_ROOTS`: default is the daemon user’s Home
- **Set explicitly**: replaces that Home default; Home is no longer implied
- **Explicit empty**: only live Herdr roots remain
- Entries must be absolute, existing, canonicalizable directories; relative, missing, or failed resolution → fail-closed
- A new worktree target may be a **direct sibling** of a live checkout (same parent). That only authorizes the new directory; it does not turn the parent into a general cwd root

Illegal, relative, or escaping paths fail. Pairfob does not rewrite them into a guess that succeeds.

On Unix, multiple roots are colon-separated:

```sh
PAIRFOB_ALLOWED_ROOTS=/Users/me/src:/Volumes/work
```

## How mutations land

Every change carries a fresh `operation_id`. It is not an instruction to retry, and it must not be reused for a different payload.

- Pairfob **never** automatically retries a mutation
- `unknown_outcome` (for example a restart mid-flight): refresh the frame, **do not replay**
- The UI may say the computer might already have applied the operation — refresh first, do not tap again
- Opening a worktree that is already open, or a no-op layout, succeeds as `noop` and does not invent a new pane

Before a side effect starts, the computer journals the intent. After a crash, a pending row is an unknown outcome and is never replayed.

## What the web surface refuses

- Arbitrary commands or environment injection
- Deleting / force-deleting worktrees
- Stealing focus (create and layout always use `focus=false`)
- Unrestricted full-page layout overlay
- Herdr server / plugin / integration admin
- Letting the phone name a transcript path for history

These are product boundaries, not missing buttons.
