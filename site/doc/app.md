---
title: Using the app
description: List, open a session, system keyboard, tappable dialogs. Controls appear only when the computer supports them.
---

# Using the app

Pairfob opens on the session list from the computer. Tapping a card opens that session, not a copy and not a screenshot.

Labels below are the English Pairfob strings. **Settings → Language** can pin **English**, **中文**, or **Browser default**.

Wide layouts (roughly a landscape tablet or a desktop browser) use two columns: list on the left, session on the right. Phones are one screen at a time. Swipe right from the left edge of a session to return to the list.

## The list

The default is a flat list, ordered by recent activity (create, status change, open). In **Settings**, grouping is:

- **All** — one list
- **By workspace** — Herdr workspaces
- **By agent** — agent kinds

Grouped headings toggle open and closed. The first group starts open; the rest start collapsed. When **Pinned** is present, that section and the group under it start open.

The card title is a single identity: the session name if you set one; otherwise the workspace name when it is not just the directory name; otherwise a task-like terminal title (stripping live crumbs such as `Thinking` / `Waiting for response` and a trailing ` - grok`). If none of those exist, it shows **claude**, or **Terminal** for a shell. The next line is always coordinates in the form **claude · pairfob** (Agent · folder · a non-default tab), omitting words already in the title and default tabs such as `main`. Internal IDs are never presented as names.

- **Session name** names this terminal surface only.
- **Tab name** names the tab containing one or more sessions.
- **Workspace name** names the outer project container and becomes the heading when grouped by workspace.

| Label | Meaning |
| --- | --- |
| **Needs you** | The agent is waiting for confirm or input; the card is emphasized |
| **Working** | Running |
| **Idle** | Connected, not busy |
| **Done** | This turn finished |

When Pairfob is connected, an empty list means there are no sessions yet; create one or open a terminal on the computer. Only the explicit **Herdr is not running on the computer** state means Herdr is closed. You can run `pairfob doctor` on the computer to confirm.

**New** appears in the top bar when the computer supports creating a session. The form can start a supported agent, or a **Terminal only (no agent)** pane. With no kinds listed, the dialog still opens and creates that terminal session.

Tap a card to open it. Long-press (right-click on a computer) to **Pin to top**, open another tab in this workspace, rename, or close that session. Pinned sessions move into a **Pinned** section at the top of the list and leave their workspace or Agent group; long-press again to **Unpin**. **Rename tab** appears only when the tab already has a visible name, or the tab is split; **Close the whole tab** only when split. Grouped by workspace, long-press the group heading to create a tab in that workspace, rename it, or **Close this workspace**; in other groupings workspace rename and close sit at the bottom of the card menu. Create-tab actions appear only when the computer supports them. Split stays in `···` after you open a session.

## Inside a session

Opening a session defaults to **Auto**: Terminal on a P2P direct connection when the browser supports WebGL2 and Save-Data is off, otherwise Control. The session remains on the computer; this is not a remote-desktop screenshot or another terminal running in the browser.

Chrome:

- Left: back to the list (phone)
- Center: name and status; tap to switch sessions
- While working, an interrupt control is the same as Esc
- Right: `···` **Session actions** (how this view looks and types, this pane's name, close this pane)

The four choices are under `···` → **Mode**. A switch inside a session is remembered for that session only. The default for newly opened sessions is in **Settings**.

| Mode | What it is |
| --- | --- |
| **Auto** | Chooses when the session opens: Terminal on P2P with WebGL2 unless Save-Data is on, otherwise Control |
| **Control** | Phone UI for this session: tappable choices, system keyboard |
| **Terminal** | A real terminal. Use for vim or a full-screen TUI. On a phone the default is an 80-column view you pan sideways; **Fit screen** resizes the computer to the phone width. Vertical pan still scrolls remotely |
| **Chat** | Message the Agent (this is where you send a task; it is not a `···` menu item). The run collapses after the reply |

In **Control**:

- The compose box uses the **system keyboard**, including dictation and autocorrect. **Compose / Live** switches sit above the field
- Choices become tappable buttons; empty Enter cannot stand in for tapping them
- The trailing control is **Enter**: with no draft it is a terminal Return; with a draft it types then confirms
- Tapping a row can copy the line, copy a path, quote into compose, or start text selection
- Swipe or **Page up** pages the live view; it does not dump history
- Font size is remembered
- Long lines can wrap or not

A dialog confirmed on the computer is already confirmed on the phone, and the reverse. There is no phone-side draft and no “pending sync” queue.

## Actions that may appear on this view

Tap the session chrome `···`. Missing items are not drawn. **Rename tab**, **Rename workspace**, **Close the whole tab**, and **Close this workspace** live on the list long-press menu, not here.

| Group | May include |
| --- | --- |
| Mode | Auto, Control, Terminal (vim / TUI), Chat |
| Input | Compose, Live (Control) |
| Display | Wrap long lines (Control), width Fit screen / 80 columns (Terminal), Select text, Larger text / Smaller text, Copy screen text. **Chat** does not show this group |
| New | New tab, Split |
| Worktree | Worktree list, New worktree, Open worktree |
| Layout | Make this pane larger, Swap with the facing pane |
| (ungrouped) | Rename session, Close this session |

**Chat** groups thinking and tools into a collapsible run that closes once the reply is in. Expand the run to see arguments and results.

The web surface does not offer arbitrary shell, deleting worktrees, or yanking the computer window to the front.

## Settings

From the top-right of the list (**Settings**).

- **Connection:** computer name, online state, this phone’s label (for example iPhone), and **Network path** as **Auto** / **P2P** / **Relay**. Auto prefers a direct path; P2P tries one now; Relay stays on the relay. The current path and round-trip sit on the same card. The choice is remembered in this browser. **Add another computer** starts another pairing without replacing the current one. With more than one credential, **Switch computer** appears here and **Computers** appears in the top bar
- **Language:** **Browser default**, or pin **中文** / **English**. This only changes Pairfob on this device. Docs have their own language menu in the top bar; both remember `pairfob_lang`
- **Session list:** grouping (**All** / **By workspace** / **By agent**)
- **Mode:** defaults to **Auto**, or can be pinned to **Control** / **Terminal** / **Chat**. A later switch is remembered per session
- **Input:** send after composing, or type live into the terminal. The trailing button only submits composed text; use the system keyboard or keypad for a deliberate bare Enter
- **Notifications:** see [Notifications](/push). Once enabled, this phone is notified when an Agent needs you or finishes; if the computer has not enabled push, it shows **Off on the computer**
- **Paired devices:** label, online or offline, last used, and notification state. The current row is marked **This phone**. Other rows have **Unpair**; already unpaired rows are omitted
- **Danger zone:** **Unpair this phone**. Pairing is required to connect again

A lost phone that can still open Pairfob can also unpair other devices from Settings. `pairfob forget` that phone on the computer immediately — [Multiple devices](/devices).

## Another window

If another browser window of the same paired device opens Pairfob, the old window may say **Another window took over this phone**. Keep a single open page.

## Add to Home Screen

See [Get started](/start#add-to-home-screen). On iOS, prefer Safari → Add to Home Screen for daily use.
