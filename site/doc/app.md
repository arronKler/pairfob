---
title: Using the app
description: List, open a session, use the system keyboard, and respond when an agent needs you. Controls appear only when the computer supports them.
---

# Using the app

Pairfob opens on the session list from the computer. Tapping a card opens that session, not a copy and not a screenshot.

Labels below are the English Pairfob strings. **Settings → Language** can pin **English**, **中文**, or **Browser default**.

Wide layouts (roughly a landscape tablet or a desktop browser) use two columns: list on the left, session on the right. Phones are one screen at a time. Swipe right from the left edge of a session to return to the list.

## The list

The default groups by **Workspace**, meaning by project directory. The **Workspace** button at the top right of the list opens **Group by**:

- **Workspace** — Herdr workspaces (default)
- **Agent** — agent kinds
- **All** — no grouping, one list

The same sheet has **Expand all** / **Collapse all**. Cards and groups follow the order you last opened them; a status change never moves a row.

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

When Pairfob is connected, an empty list means there are no sessions yet; create one or open a terminal on the computer. Only the explicit **Herdr is not running on the computer** state means Herdr is closed. You can run `pairfob doctor` on the computer to confirm.

**New** appears when the computer supports creating a session: bottom right on a phone, at the top of the left rail on a wide screen. **New tab** (list long-press or session `···`) and **Split** (session `···`) use the same kind list. Each form can start a supported agent, or a **Terminal only (no agent)** pane. With no kinds listed, the dialog still opens and creates that terminal session. An in-flight worktree shows a progress card above the list until it finishes.

Tap a card to open it. Long-press (right-click on a computer) to **Pin to top**, open another tab in this workspace, rename, or close that session. Pinned sessions move into a **Pinned** section at the top of the list and leave their workspace or Agent group; long-press again to **Unpin**. **Rename tab** appears only when the tab already has a visible name, or the tab is split; **Close the whole tab** only when split. Grouped by workspace, long-press the group heading to create a tab in that workspace, rename it, or **Close this workspace**; in other groupings workspace rename and close sit at the bottom of the card menu. Create-tab actions appear only when the computer supports them. Split stays in `···` after you open a session.

**Board** (also **Tab layout** in a card's long-press menu, and **View on the board** in a session's `···`) draws the current tab the way the computer shows it: every pane sits where it does in Herdr at the same size, shows its real screen, and scales with the pinch (Ctrl + scroll on a computer). A title bar on each pane shows the agent, name and status. Tap the title to switch workspace; the row under it holds that workspace's tabs. **+** creates a tab (long-press it for **Start another**), and long-pressing a tab renames, creates or closes tabs. Switching workspace or tab here does not steal focus on the computer.

Tap a pane to open that session; drag up or down on a pane to scroll its screen on the computer. Long-press a pane (right-click on a computer, or tap `···` in its title bar) for **Split…**, **Resize**, **Swap position…**, **Maximize on computer**, rename and close. You can also drag the divider between panes to resize, or long-press a pane and drop it on a neighbour to swap. These change the split on the computer right away; each appears only when the computer supports it, and while reconnecting the board is view-only. On a wide screen the board sits on the right and the left rail stays the session list; with the canvas focused, Herdr's keys work too: arrows select a pane, Shift + arrow swaps, Option + arrow resizes, `v` / `-` split, `z` maximizes, `x` closes, `0` fits.

On a phone, the bottom bar has **Sessions** / **Board** / **Settings**; **Sessions** shows a count when something needs you. On a wide screen the same entries sit in a row at the top of the left rail: **New** / **Computers** / **Board** / **Settings**.

## Inside a session

Opening a session defaults to **Auto**: Terminal on a P2P direct connection when the browser supports WebGL2 and Save-Data is off, otherwise Control. The session remains on the computer; this is not a remote-desktop screenshot or another terminal running in the browser.

Chrome:

- Left: back to the list (phone). The back control shows a count when other sessions need you
- Center: agent icon, name and status. It is display-only; switch sessions from the list or with the edge swipe
- Right: **Browse files and changes**, then `···` **Session actions** (how this view looks and types, this pane's name, close this pane)

Stopping a working agent lives on the button beside the compose field; see **Control** below.

The four choices are at the top of `···` under **Mode**. A switch inside a session is remembered for that session only. The default for newly opened sessions is in **Settings**.

| Mode | What it is |
| --- | --- |
| **Auto** | Chooses when the session opens: Terminal on P2P with WebGL2 unless Save-Data is on, otherwise Control |
| **Control** | View the terminal and operate the session with the system keyboard and keypad |
| **Terminal** | A real terminal. Use for vim or a full-screen TUI. On a phone the default is an 80-column view you pan sideways; **Fit screen** resizes the computer to the phone width. Vertical pan still scrolls remotely |
| **Chat** | Message the Agent (this is where you send a task; it is not a `···` menu item). The run collapses after the reply |

In **Control**:

- The compose box uses the **system keyboard**, including dictation, autocorrect and several lines. On a phone keyboard Return adds a new line; tap **Send** when done. To make Return send, turn on **Return key sends** in Settings. On an external keyboard Enter sends and Shift+Enter adds a line
- The button beside the field changes with the situation:
  - With a draft: **Send** types it into the terminal and presses Enter
  - No draft while the agent is working: **Stop** sends Esc; if it keeps working the button becomes **Force stop**, and only a second tap sends Ctrl+C, once. Long-pressing **Send** while it works also stops it
  - Otherwise: **Enter** (↵) sends a terminal Return
- **Compose / Live** is under `···` → **Input and display** → **Input**, for this session only; Live marks the field with **Live**
- Confirmation choices stay in the terminal view. Follow the prompt: use the keypad's ↑/↓ to select, then Enter to confirm. Type a letter or text when the prompt asks for it
- Tapping a row offers **Copy**, **Copy path**, **Quote** into compose, or **Select…** text
- Swipe or **Page up** pages the live view; it does not dump history
- Font size is remembered
- Long lines can wrap or not
- The first keypad row is Esc, arrows and Backspace. `···` expands it; switch between **Keys** and **Commands**. Keys has two pages, **Control** (Ctrl, Alt, Shift, Cmd, Tab, Shift+Tab, Enter, Ctrl+C and more) and **Select & edit**; Commands holds the agent's slash commands (such as `/clear`, typed into the terminal; Pairfob does not interpret them) and your own saved commands, which you can add, edit and reorder

When **Chat** shows **Needs you**, tap **Go confirm** to switch to **Control** and read the terminal prompt. Check the operation and current selection before confirming. You can also switch to **Terminal** through `···` → **Mode** when needed.

The computer and phone operate the same terminal dialog. Once either confirms it, the other sees the updated state. If the prompt is missing on the phone, handle it on the computer and report the phone's mode, Agent / extension versions, and a redacted recording.

## Files and changes

The folder control in the session chrome is not the Worktree menu. It opens this pane's workspace, with the current branch and how many commits it is ahead at the top:

- **Files** — directory listing and a text preview
- **Changes** — uncommitted git status in **Staged Changes** and **Changes**; tap a file for the diff
- A diff switches between **Staged** and **Working tree**, **Open file** shows the whole file, and **Previous** / **Next** at the bottom step through changed files
- Tap a diff line to comment, then **Send to agent**
- The branch list is read-only. Switch work with worktree actions

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

**PDFs are supported and transferred unchanged.** **Choose file** does not restrict extensions: text, Markdown, JSON, images, Office documents, archives, audio and video can also be selected. Upload support does not imply that Pairfob previews or parses a format.

The computer saves attachments under controlled filenames. A PDF correctly identified by the browser is saved with `.pdf`; types without a dedicated mapping, or without a recognized type, may be saved as `.bin` with their contents unchanged.

| Limit | Current value |
| --- | --- |
| Attachment queue per session | Up to 5 files |
| Actual uploaded file | Up to 20 MiB each |
| Actual uploaded total in the same queue | Up to 40 MiB |
| Source files retained locally | Up to 80 MiB total |

Eligible JPEG photos can be selected at up to 40 MiB per source file, but the compressed result must still meet the upload limits. PDFs and other ordinary files are limited to 20 MiB at selection. **Local retained capacity is not an upload allowance.** If compression fails or Original leaves a file over the limit, reduce its size first.

### Smart image compression

The default is **Photo → Smart compress**. Processing starts when P2P is ready and the upload begins, not immediately when you select an image:

- Ordinary JPG/JPEG photos larger than 256 KiB are compression candidates, with an output long edge of at most 2048 pixels. PNGs produced by editing a JPEG photo may also use this path.
- Ordinary PNG, WebP, AVIF, HEIC/HEIF, GIF and SVG files stay original. Files recognized as screenshots by their names also skip automatic compression.
- **Text & detail** or **Original** skips this compression step. Original keeps any edits already made.
- Files of 256 KiB or less, failed compression, or results saving less than 10% keep the original.

Each file shows the actual size savings or why the original was kept. Choose **Text & detail** for text screenshots, error messages and fine diagrams.

### Interruptions, status checks and resuming

**File uploads use P2P only.** Relay can show the session and **Check status**, but cannot start or continue sending files. Unsent queue work stops when P2P is unavailable; prepared image results can be reused. After reconnecting, explicitly tap **Upload**, **Upload all**, or **Continue upload**.

After an interruption or an uncertain result, use **Check status** to find out how much the computer has received. This only reads status and never resumes automatically. Once P2P is ready, tap **Continue upload**. After a page reload, the browser attempts to restore unfinished attachments saved locally. Recovery is not guaranteed if browser storage is unavailable or its records have been cleared; follow the on-screen instructions.

**Transfer details** separates hashing, local saving, sending and other measured stages. **Saving resume information** means the browser is storing its recovery record; that file has not entered the network sending stage yet.

## Actions that may appear on this view

Tap the session chrome `···`. Missing items are not drawn. **Rename tab**, **Rename workspace**, **Close the whole tab**, and **Close this workspace** live on the list long-press menu, not here.

| Group | May include |
| --- | --- |
| Mode | Auto, Control, Terminal (vim / TUI), Chat |
| Tiles | Copy screen, New tab, Split, Rename |
| Input and display | Input: Compose / Live (Control), Larger text / Smaller text, Wrap long lines (Control), Fit width to screen (Terminal) |
| Session | Layout (drag dividers to resize, long-press this pane to swap it, zoom), Worktree (list, new, open), Agent info, Close session |

**Chat** groups thinking and tools into a collapsible run that closes once the reply is in. Expand the run to see arguments and results. **Copy reply** sits on a finished answer. **Load earlier** pulls older turns when the thread is long.

The web surface does not offer arbitrary shell, deleting worktrees, or yanking the computer window to the front.

## Settings

Tap **Settings** at the bottom on a phone, or at the top of the left rail on a wide screen.

- **Connection:** computer name, online state, this phone’s label (for example iPhone), and **Network path** as **Auto** / **P2P** / **Relay**. Auto prefers a direct path; P2P tries one now; Relay stays on the relay. The current path and round-trip sit on the same card. The choice is remembered in this browser. **Add another computer** starts another pairing without replacing the current one. With more than one credential, **Switch computer** appears here and **Computers** appears in the top bar
- **Subscription quota:** allowance for accounts signed in on this computer (Codex, Claude Code, GitHub Copilot, Cursor, Grok, Antigravity). Overview rings; **Usage details** for each window. **Refresh quota** on that page. Missing or stale data is not shown as zero
- **Language:** **Browser default**, or pin **中文** / **English**. This only changes Pairfob on this device. Docs have their own language menu in the top bar; both remember `pairfob_lang`
- **Mode:** defaults to **Auto**, or can be pinned to **Control** / **Terminal** / **Chat**. A later switch is remembered per session
- **Input:** whether new sessions start in Compose (write, then Send) or Live (type straight into the terminal). `···` → **Input and display** switches one session only
- **Return key sends:** off by default, so the phone keyboard's Return adds a line and the send button sends; turn it on to send with Return. External keyboards always send with Enter and add a line with Shift+Enter
- **Notifications:** see [Notifications](/push). Once enabled, this phone is notified when an Agent needs you or finishes; if the computer has not enabled push, it shows **Off on the computer**
- **Paired devices:** label, online or offline, last used, and notification state. The current row is marked **This phone**. Other rows have **Unpair**; already unpaired rows are omitted
- **Export connection diagnostics:** export recent connection events when something goes wrong; see the [FAQ](/faq)
- **Computer update:** a reminder on the list, and **Check for updates** / **Update computer** on the **Computer version** row in Settings when the user service can do it. Confirming briefly disconnects, then reconnects. Never automatic. Command-line: [CLI](/cli)
- **Danger zone:** **Unpair this phone**. Pairing is required to connect again

A lost phone that can still open Pairfob can also unpair other devices from Settings. `pairfob forget` that phone on the computer immediately — [Multiple devices](/devices).

## Named Herdr sessions

If you run more than one Herdr server on the computer (`herdr --session <name>`), the phone can switch between them. When a named session is running or you have one selected, the current Herdr session shows as a pill in the Sessions header (in the left rail on a wide screen), and as **Herdr session** in Settings. The switch stays available if the selected named server stops, so you can return to Default. Tap either to pick another; the list marks which ones are running.

Named sessions are enabled by default. If `HERDR_SOCKET_PATH` is set and `PAIRFOB_MULTI_SESSION` is unset or empty, multi-session stays off. Set `PAIRFOB_MULTI_SESSION=1` to enable it with a pinned socket. Other non-empty values keep it off.

To turn it off, run this on the computer, in the same shell you would normally install from:

```sh
PAIRFOB_MULTI_SESSION=0 pairfob service install
```

`service install` rewrites the user service from the current shell's environment, so also export any other variable you set at install time (for example `HERDR_SOCKET_PATH`), or it is dropped. The setting then survives restarts and `pairfob update`.

Current limits:

- Pairfob starts only the default server at the configured socket; start named servers yourself. If you use only named sessions, a reboot leaves an empty default server unless you set `PAIRFOB_HERDR_AUTOSTART=0`
- Notifications come from the default Herdr session only
- Older computers without this support show no switch

## Another window

If another browser window of the same paired device opens Pairfob, the old window may say **Another window took over this phone**. Keep a single open page.

## Add to Home Screen

See [Get started](/start#add-to-home-screen). On iOS, prefer Safari → Add to Home Screen for daily use.
