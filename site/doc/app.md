---
title: Using the app
description: List, open a session, use the system keyboard, the mouse and keyboard on a wide screen, and respond when an agent needs you. Controls appear only when the computer supports them.
---

# Using the app

Pairfob opens on the session list from the computer. Tapping a card opens that session, not a copy and not a screenshot.

Labels below are the English Pairfob strings. **Settings → Language** can pin **English**, **中文**, or **Browser default**.

Phones are one screen at a time; swipe right from the left edge of a session to return to the list. In a window 720px or wider (a tablet, a desktop browser) the list stays on the left with the session beside it; see [Tablets and desktop browsers](#tablets-and-desktop-browsers). What follows describes the phone first. Where it says long-press for a menu, right-click with a mouse.

## The list

The default groups by **Workspace**, meaning by project directory. The **Workspace** button at the top right of the list opens **Group by**:

- **Workspace** — Herdr workspaces (default)
- **Agent** — agent kinds
- **All** — no grouping, one list

The same sheet has **Expand all** / **Collapse all**. Cards and groups follow the order you last opened them; a status change never moves a row. On a wide screen the list stays beside the session, so opening one session after another does not reorder it; it is sorted by last opened again after you switch computer or grouping, reload the page, or come back to this browser tab.

Grouped headings toggle open and closed. The first group starts open; the rest start collapsed. When **Pinned** is present, that section and the group under it start open.

When a session is waiting on you, a **Needs you** strip at the top of the list lists it; one tap opens it.

The card title is a single identity: the session name if you set one; otherwise the workspace name when it is not just the directory name; otherwise a task-like terminal title (stripping live crumbs such as `Thinking` / `Waiting for response` and a trailing ` - grok`). If none of those exist, it shows **claude**, or **Terminal** for a shell. The next line is always coordinates in the form **claude · pairfob** (Agent · folder · a non-default tab), omitting words already in the title and default tabs such as `main`. Internal IDs are never presented as names.

- **Session name** names this terminal surface only.
- **Tab name** names the tab containing one or more sessions.
- **Workspace name** names the outer project container and becomes the heading when grouped by workspace.

| Label | Meaning |
| --- | --- |
| **Needs you** | The agent is waiting for confirm or input; the card is emphasized |
| **Working** | Running |
| **Turn finished** | This turn is done |
| **Waiting for input** | Ready for the next thing you give it |
| **Idle** | Connected, not busy |
| **Starting** | The agent is starting up |
| **Unknown** | The computer did not report a status, or it cannot be confirmed right now |

When Pairfob is connected, an empty list means there are no sessions yet; create one or open a terminal on the computer. Only the explicit **Herdr isn't running on the computer** state means Herdr is closed. You can run `pairfob doctor` on the computer to confirm.

**New** appears when the computer supports creating a session: bottom right on a phone, **＋** at the top of the left rail on a wide screen. **New tab** (list long-press or session `···`) and **Split** (session `···`) use the same kind list. Each form can start a supported agent, or a plain **Terminal** pane. With no kinds listed, the dialog still opens and creates that terminal session. An in-flight worktree shows a progress card above the list until it finishes.

Tap a card to open it. Long-press (right-click with a mouse) for the card's menu: **Pin to top**, **Rename session**, **Close session**, **Tab layout**, and **New tab** in the same workspace. Pinned sessions move into a **Pinned** section at the top of the list and leave their workspace or Agent group; long-press again to **Unpin**. **Rename tab** appears only when the tab already has a visible name, or the tab is split; **Close tab** only when split. Grouped by workspace, long-press the group heading (or tap `···` beside it) for **New tab**, **Open in Board**, **Rename workspace**, or **Close workspace**; in other groupings **Rename workspace** and **Close workspace** sit at the bottom of the card menu. Create-tab actions appear only when the computer supports them. Split stays in `···` after you open a session.

With a finger, swipe a card left for **Pin** and **More** (the menu above); swipe an unread finished card right to mark it **Read**.

**Board** (also **Tab layout** in a card's long-press menu, and **View on the board** under `···` → **Layout** in a session) draws the current tab the way the computer shows it: every pane sits where it does in Herdr at the same size, shows its real screen, and scales with the pinch (Ctrl + scroll with a mouse). A title bar on each pane shows the agent, name and status. Tap the title to switch workspace; the row under it holds that workspace's tabs. **+** creates a tab (long-press it for **Start another**), and long-pressing a tab offers **Rename tab**, **New tab** and **Close tab**. Switching workspace or tab here does not steal focus on the computer.

Tap a pane to open that session; drag one finger up or down on a pane to scroll its screen on the computer, and drag two fingers to move the board. Long-press a pane (right-click with a mouse, or tap `···` in its title bar) for **Split**, **Resize**, **Swap position**, **Maximize on computer**, **Rename session** and **Close session**. You can also drag the divider between panes to resize. A long-press with a finger lifts the pane: drop it on a neighbour to swap, or let go in place for the menu; the tab row says what letting go will do. These change the split on the computer right away; each appears only when the computer supports it, and while reconnecting the board is view-only.

On a wide screen the board takes the main column and the left rail stays the session list; in a window narrower than 900px the board takes the full width, with back to the list at the top left. With a mouse, a sideways scroll or Shift + scroll moves the board, and a vertical scroll scrolls the pane under the pointer on the computer; when the board is zoomed past the window, a vertical scroll or drag moves the board first, and the wheel scrolls the pane only once the board's edge is in view. With the canvas focused, Herdr's keys work too: arrows select a pane, Shift + arrow swaps, Option + arrow resizes, `v` / `-` split, `z` maximizes, `x` closes, `0` fits.

On a phone, the bottom bar has **Sessions** / **Board** / **Settings**; **Sessions** shows a count when something needs you. On a wide screen **Board** and **Settings** sit at the bottom of the left rail, with create and the computer switch at its top.

## Inside a session

Opening a session defaults to **Auto**: Terminal on a P2P direct connection when the browser supports WebGL2 and Save-Data is off, otherwise Control. The session remains on the computer; this is not a remote-desktop screenshot or another terminal running in the browser.

Chrome:

- Left: back to the list (phone; on a wide screen only while the rail has given way to files and changes). The back control shows a count when other sessions need you
- Center: agent icon, name and status. It is display-only; switch sessions from the list or with the edge swipe
- Right: **Browse files and changes**, then `···` **Session actions** (how this view looks and types, this pane's name, close this pane)

Stopping a working agent lives on the button beside the compose field; see **Control** below.

The four choices are at the top of `···`. A switch inside a session is remembered for that session only. The default for newly opened sessions is in **Settings**.

| Mode | What it is |
| --- | --- |
| **Auto** | Chooses when the session opens: Terminal on P2P with WebGL2 unless Save-Data is on, otherwise Control |
| **Control** | View the terminal and operate the session with the system keyboard and keypad |
| **Terminal** | A real terminal. Use for vim or a full-screen TUI. On a phone the default is an 80-column view you pan sideways; **Fit** resizes the computer's terminal to this screen's width. Vertical pan and the mouse wheel scroll remotely; a URL on screen opens in a new tab when you tap or click it |
| **Chat** | Message the Agent (this is where you send a task; it is not a `···` menu item). Each turn's work sits in one step card: open while it runs, one result line after. Available for Claude Code, Codex, Grok, Pi, Cursor, Hermes and opencode sessions; the last three open once the agent has saved the session, which for Cursor is after its first message. Cursor records no step results, so its steps show as ended rather than succeeded or failed. Hermes needs `sqlite3` on the computer; opencode 1.2 and later is not read yet |

In **Control**:

- The compose box uses the **system keyboard**, including dictation, autocorrect and several lines. On a phone keyboard Return adds a new line; tap **Send** when done. To make Return send, turn on **Return key sends** in Settings. On an external keyboard Enter sends and Shift+Enter adds a line
- The button beside the field changes with the situation:
  - With a draft: **Send** types it into the terminal and presses Enter
  - No draft while the agent is working: **Stop** sends Esc; if it keeps working the button becomes **Force stop**, and only a second tap sends Ctrl+C, once. Long-pressing **Send** while it works also stops it
  - Otherwise: **Enter** (↵) sends a terminal Return
- **Compose / Live** is under `···` → **Input and display** → **Input**, for this session only; Live marks the field with **Live**
- Confirmation choices stay in the terminal view. Follow the prompt: use the keypad's ↑/↓ to select, then Enter to confirm. Type a letter or text when the prompt asks for it
- Tapping a row offers **Copy**, **Copy path**, **Quote** into compose, or **Select** text
- Swipe or **Page up** pages the live view; it does not dump history
- Font size is remembered
- Long lines can wrap or not
- The first keypad row is Esc, arrows and Backspace. `···` expands it; switch between **Keys** and **Commands**. Keys has two pages, **Control** (Ctrl, Alt, Shift, Cmd, Tab, Shift+Tab, Enter, Ctrl+C and more) and **Select & edit**; Commands holds the agent's slash commands (such as `/clear`; tapping one puts it at the start of your draft, or types it into the terminal in Live input. Neither presses Enter, and Pairfob does not interpret them) and your own saved commands, which you can add, edit and reorder

When the Agent waits on you in **Chat**, the turn shows a **Needs your confirmation** card with the prompt from the terminal. When that prompt is a numbered list (Claude Code and Codex approvals), pick an option on the card and tap **Send choice**: before sending, the computer checks that the terminal screen has not changed; if it has, the card reads it again and asks you to choose again. Nothing is resent on its own. Other prompts show the last lines of the terminal. **Handle in terminal** always switches to **Control**; check the operation and current selection before confirming.

The computer and phone operate the same terminal dialog. Once either confirms it, the other sees the updated state. If the prompt is missing on the phone, handle it on the computer and report the phone's mode, Agent / extension versions, and a redacted recording.

## Tablets and desktop browsers

The window's width decides the layout; whether you point with a finger or a mouse decides how it handles. A landscape tablet and a laptop window of the same width get the same columns: the tablet keeps swipes, long-press and the keypad, the laptop gains hover actions and keyboard shortcuts.

| Window width | Layout |
| --- | --- |
| Under 720px | Phone layout: one screen at a time, three tabs at the bottom |
| 720–899px | Left rail + session. **Browse files and changes** and the board each take the full width, with back at the top left |
| 900–1199px | Left rail + session. **Browse files and changes** opens in a column right of the session and the rail gives way; the session gets a back control at the top left with the count of other sessions that need you, and it closes the column and returns the list |
| 1200px and up | Three columns: list, session, files and changes |

A phone turned sideways keeps the phone layout below 900px, and **Terminal** always takes the whole screen on a phone.

A session stays beside the list in every mode, **Terminal** included. With no session open, the main column lists the sessions that need you and offers **New session** and **Search or jump**.

### The left rail

Top to bottom:

- The computer's name and connection status. It opens the **Computers** menu: switch computer, **Connection details**, **Add a computer**. Grouping and **＋** sit on the same row
- **Search or jump…** searches sessions, workspaces and actions. With nothing typed, sessions waiting on you come first, and Enter opens the highlighted one. On macOS ⌘K opens it too; other systems have no shortcut, so click the field
- The **Needs you** strip; one tap opens a session
- The session list
- **Board** and **Settings** at the bottom

With a mouse, **＋** opens a menu of recent combinations whose last row, **New session**, opens the full create panel; with nothing recent it opens the panel directly. With a finger, a tap opens the panel and a long-press offers the recent combinations.

### Mouse and keyboard

- Hover a row in the list for **Pin** and **More**, plus **Read** on an unread finished session: the same buttons a swipe reveals
- Right-click a row, a group heading, or a pane or tab on the board for its menu
- Menus and panels open where you clicked, and dialogs are centered cards; a finger still gets bottom sheets
- In **Control** the keypad folds behind **Keys** beside the compose field, a **Compose** / **Live** switch sits under the field, and terminal text can be selected by dragging

With a hardware keyboard:

| Key | What it does |
| --- | --- |
| F6 / Shift+F6 | Move between the list, the session, and files and changes |
| ↑ / ↓ | Walk the rows while focus is in the list; → reaches a row's actions, ← comes back |
| Esc | Closes the top-most menu, panel or dialog when one is open. With focus in files and changes it closes the open file or diff first, then the column. While the session holds the keyboard, Esc in **Control** and **Terminal** goes to the program |
| PageUp / PageDown | Page the session |
| ⌘K | **Search and jump**, macOS only |

While the session holds the keyboard, typing goes straight into its compose field without a click. With focus in the list, in files and changes, or in any menu, keys are not sent to the session, so Ctrl+C over a diff copies and does not interrupt the agent beside it.

- **Compose:** Enter sends, Shift+Enter adds a line, and Control chords such as Ctrl+C and Ctrl+D go to the program. Tab goes to the program while the field is empty and leaves the field once there is a draft; Shift+Tab always leaves the field
- **Live:** every key goes to the program, Tab and Shift+Tab included; only F6 moves the keyboard out of the session
- With terminal text selected, Ctrl+C copies and does not interrupt. On macOS copying is ⌘C, and Ctrl+C always goes to the program

### Touch tablets

A touch tablet keeps the phone's ways: swipes, long-press, bottom sheets and the keypad. Once a hardware keyboard is attached, the first physical key you press is recognized: Enter then sends, and the keys above work. When the on-screen keyboard comes up again, Return adds a line again.

## Files and changes

The folder control in the session chrome is not the Worktree menu. It opens this pane's workspace, with the current branch and how many commits it is ahead at the top:

- **Files** — directory listing and a text preview
- **Changes** — uncommitted git status in **Staged Changes** and **Changes**; tap a file for the diff
- A diff switches between **Staged** and **Working tree**, **Open file** shows the whole file, and **Previous** / **Next** at the bottom step through changed files
- Tap a diff line to comment, then **Send to agent**
- The branch list is read-only. Switch work with worktree actions

In a window 900px or wider the folder control opens and closes a column right of the session without leaving it:

- **Changes** comes before **Files** there; outside a Git repository there is only the file view
- Opening a file or diff folds the list into the file's name at the top; click it to return to the list
- A comment is written under its line. Esc sets it aside: what you typed waits under the line marked **Not saved**, and pressing it resumes; only **Cancel** discards it
- **Send to agent** sends to the session beside it
- **Open as a full page** is at the top right, next to closing the column. A window that gets too narrow puts the column away, and it comes back on the same file or diff with any half-written comment
- In **Terminal**, opening or closing the column does not resize the terminal on the computer, and neither does a multi-line draft

If the computer daemon cannot inspect the workspace, the page says so.

## Upload attachments

Tap the attach button left of the compose field (**Add attachments**) and use the system picker for files, photos or the camera; you can also paste. The entry appears only when the computer supports uploads. If it is missing, check the connection and update Pairfob on the computer.

### Upload and pass a file to the Agent

1. Picked files appear in the attachment row above the compose field. Images can be edited first, and each can switch between **Smart compress** and **Original**.
2. On a **P2P direct connection** uploads start by themselves. Without one, the row says **Uploads need a direct connection**; tap **Connect**.
3. Write your instructions and tap **Send**. Uploaded paths are attached after the text, in the row's order. While something is still uploading the button shows **Uploading N%** and sends when it finishes; tap it to stop waiting. If an attachment cannot finish, you can **Retry**, **Connect**, or **Send without them**.
4. To place a path at a specific spot in your text, choose **Put in message** for that attachment.

Files are saved in the current session's workspace on the computer. Uploading alone never sends a task or presses terminal Enter; it all goes out when you tap **Send**. File transfer works independently of which Agent is running; reading a PDF, understanding an image, or parsing an Office document depends on that Agent's model and tools.

### File types and limits

**PDFs are supported and transferred unchanged.** The system picker does not restrict extensions: text, Markdown, JSON, images, Office documents, archives, audio and video can also be selected. Upload support does not imply that Pairfob previews or parses a format.

The computer saves attachments under controlled filenames. A PDF correctly identified by the browser is saved with `.pdf`; types without a dedicated mapping, or without a recognized type, may be saved as `.bin` with their contents unchanged.

| Limit | Current value |
| --- | --- |
| Attachment queue per session | Up to 5 files |
| Actual uploaded file | Up to 20 MiB each |
| Actual uploaded total in the same queue | Up to 40 MiB |
| Source files retained locally | Up to 80 MiB total |

Eligible JPEG photos can be selected at up to 40 MiB per source file, but the compressed result must still meet the upload limits. PDFs and other ordinary files are limited to 20 MiB at selection. **Local retained capacity is not an upload allowance.** If compression fails or Original leaves a file over the limit, reduce its size first.

### Smart image compression

Images default to **Smart compress**. Processing starts when P2P is ready and the upload begins, not immediately when you select an image:

- Ordinary JPG/JPEG photos larger than 256 KiB are compression candidates, with an output long edge of at most 2048 pixels. PNGs produced by editing a JPEG photo may also use this path.
- Ordinary PNG, WebP, AVIF, HEIC/HEIF, GIF and SVG files stay original. Files recognized as screenshots by their names also skip automatic compression.
- **Original** skips this compression step and keeps any edits already made.
- Files of 256 KiB or less, failed compression, or results saving less than 10% keep the original.

**Preview → Info** shows the actual size savings or why the original was kept. Tap **Use original** on text screenshots, error messages and fine diagrams.

### Interruptions, status checks and resuming

**File uploads use P2P only.** Relay can show the session, but cannot start, continue or check uploads. Unsent queue work stops when P2P is unavailable; prepared image results can be reused. Once the direct connection is back, files that had not started yet upload by themselves; tap **Continue upload** on a **Paused** file or **Try again** on a failed one, and **Continue all** for files left unfinished from last time.

When a result is uncertain (for example a cancellation the computer never confirmed), the file offers **Check status** instead. It connects directly first if needed, then only reads how much the computer has received; it never resumes by itself. After a page reload, the browser attempts to restore unfinished attachments saved locally. Recovery is not guaranteed if browser storage is unavailable or its records have been cleared; follow the on-screen instructions.

Open an attachment's **Preview** and tap **Info** for its size, saved path and how long each stage took (**Compression**, **Hashing**, **Local save**, **Sending** and so on). **Local save** is the browser storing its recovery record; it comes before that file's network sending stage.

## Actions that may appear on this view

Tap the session chrome `···`. Missing items are not drawn. **Rename tab**, **Rename workspace**, **Close tab**, and **Close workspace** live on the list long-press menu, not here. With a mouse the panel opens under `···`; with a finger it is a bottom sheet.

| Group | May include |
| --- | --- |
| Mode | Auto, Control, Terminal (vim / TUI), Chat |
| Tiles | Copy text, New tab, Split, Rename |
| Input and display | Input: Compose / Live, Text size, Wrap long lines (Control), Width (columns): Fit / 80 / 100 / 120 (Terminal). Not shown in Chat |
| Session | Layout (drag dividers to resize, long-press this pane to swap it, zoom), Worktree (list, new, open), Agent info, Close session |

**Chat** puts a turn's thinking and tools in one step card. Its header leads with the result: waiting on you, which files changed, how many steps and how long. A failed step the agent worked past is only marked in the list; the header says so only when the turn stopped on one. It is open with the latest steps while the turn runs and one line afterwards; long turns can filter to failed or edited steps. Tap a step for its command or arguments and output, copy them, and move with **Previous** / **Next**. A finished answer has **Copy**, each code block its own **Copy code**. **Load earlier** pulls older turns when the thread is long.

The web surface does not offer arbitrary shell, deleting worktrees, or yanking the computer window to the front.

## Settings

Tap **Settings** at the bottom on a phone, or at the bottom of the left rail on a wide screen.

- **Computer card:** the computer's name above a line from **This device** to **Computer** that carries the current path and round-trip time (or **Not connected**). Tap the card for this computer's page, where **Network route** offers **Auto** / **P2P only** / **Relay only**: Auto prefers a direct path and falls back to the relay; P2P only keeps trying for a direct path and uses the relay meanwhile (tap it again to retry now); Relay only stays on the relay. The choice is remembered in this browser. That page also holds **Paired devices**, **Export connection diagnostics** and **Unpair this device**. **Switch computer** opens **Computers**, where **Add a computer** starts another pairing without replacing the current one. Tapping the computer name at the top of the session list (the top of the left rail on a wide screen) also switches and adds computers
- **Subscription quota:** allowance for accounts signed in on this computer (Codex, Claude Code, GitHub Copilot, Cursor, Grok, Antigravity). One row per service with a bar and the percentage left; **All quota** opens every window, with **Refresh quota** on that page. Missing or stale data is not shown as zero
- **Language:** **Browser default**, or pin **中文** / **English**. This only changes Pairfob on this device. Docs have their own language menu in the top bar; both remember `pairfob_lang`
- **Mode:** defaults to **Auto**, or can be pinned to **Control** / **Terminal** / **Chat**. A later switch is remembered per session
- **Input:** whether new sessions start in Compose (write, then Send) or Live (type straight into the terminal). `···` → **Input and display** switches one session only
- **Return key sends:** off by default, so the on-screen keyboard's Return adds a line and the send button sends; turn it on to send with Return. External keyboards always send with Enter and add a line with Shift+Enter; in a desktop browser with a mouse, or on a tablet with a hardware keyboard, the row reads **On-screen Return sends**
- **Notifications:** see [Notifications](/push). Once enabled, this device is notified when an Agent needs you or finishes; if the computer has not enabled push, the row says so and **How to enable** expands the setup steps
- **Paired devices** (on the computer's page): label, online or offline, last used, and notification state. The current row is marked **This device**. Other rows have **Unpair**; already unpaired rows are omitted
- **Export connection diagnostics** (on the computer's page, under **Diagnostics**): export recent connection events when something goes wrong; see the [FAQ](/faq)
- **Computer update:** a reminder on the list, and **Check for updates** / **Update computer** on the **Computer version** row in Settings when the user service can do it. Confirming briefly disconnects, then reconnects. Never automatic. Command-line: [CLI](/cli)
- **Unpair this device:** at the bottom of the computer's page. Pairing is required to connect again

A lost phone that can still open Pairfob can also unpair other devices from Settings. `pairfob forget` that phone on the computer immediately — [Multiple devices](/devices).

## Named Herdr sessions

If you run more than one Herdr server on the computer (`herdr --session <name>`), the phone can switch between them. When a named session is running or you have one selected, the current Herdr session shows as a pill in the Sessions header (in the left rail on a wide screen), and as **Herdr session** in Settings. The switch stays available if the selected named server stops, so you can return to Default. Tap either to pick another; the list marks which ones are running.

Named sessions are enabled by default. If `HERDR_SOCKET_PATH` is set to a non-default path (anything other than `~/.config/herdr/herdr.sock`) and `PAIRFOB_MULTI_SESSION` is unset or empty, multi-session stays off. Set `PAIRFOB_MULTI_SESSION=1` to enable it with a pinned socket. Other non-empty values keep it off.

To turn it off, run this on the computer, in the same shell you would normally install from:

```sh
PAIRFOB_MULTI_SESSION=0 pairfob service install
```

`service install` rewrites the user service from the current shell's environment, so also export any other variable you set at install time (for example `HERDR_SOCKET_PATH`), or it is dropped. The setting then survives restarts and `pairfob update`. To turn it back on, run `pairfob service install` again without it.

Each run lists what it removed or changed in the previous service definition's environment, including entries added by hand. Values are shown only for the variables `service install` writes itself. If the previous definition cannot be read for comparison, a copy is kept in the state directory and the command prints its path.

Current limits:

- Pairfob starts only the default server at the configured socket; start named servers yourself. If you use only named sessions, a reboot leaves an empty default server unless you set `PAIRFOB_HERDR_AUTOSTART=0`
- Notifications come from the default Herdr session only
- Older computers without this support show no switch

## Another window

If another browser window of the same paired device opens Pairfob, the old window may say **Another window took over this device's connection**. Keep a single open page.

## Add to Home Screen

See [Get started](/start#add-to-home-screen). On iOS, prefer Safari → Add to Home Screen for daily use.
