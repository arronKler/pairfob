---
title: Using the app
description: List, open a session, system keyboard, tappable dialogs. Controls appear only when the computer supports them.
---

# Using the app

Pairfob opens on the session list from the computer. Tapping a card opens that real Herdr pane, not a copy and not a screenshot stream.

The app chrome is currently Chinese. Labels below are the strings on screen.

Wide layouts (roughly a landscape tablet or a desktop browser) use two columns: list on the left, session on the right. Phones are one screen at a time. Swipe right from the left edge of a session to return to the list.

## The list

The default is a flat list, ordered by recent activity (create, status change, open). In **设置**, grouping is:

- **全部** — one list
- **按工作区** — Herdr workspaces
- **按 Agent** — agent kinds

Grouped headings toggle open and closed. The first group starts open; the rest start collapsed.

The card title is the task identity: the session name if you set one; otherwise the workspace name when it is not just the directory name; otherwise a task-like terminal title. If none of those exist, it shows **claude · pairfob** (“Agent · folder”), or **终端 · pairfob** for a shell. The next line is coordinates (workspace, Agent, a renamed tab, directory), omitting words already in the title and default tabs such as `main`. Internal IDs are never presented as names.

- **会话名** names this terminal surface only.
- **标签页名** names the tab containing one or more sessions.
- **工作区名** names the outer project container and becomes the heading when grouped by workspace.

| Label | Meaning |
| --- | --- |
| 等你 | The agent is waiting for confirm or input; the card is emphasized |
| 工作中 | Running |
| 空闲 | Connected, not busy |
| 完成 | This turn finished |

When Pairfob is connected, an empty list means there are no sessions yet; create one or open a terminal on the computer. Only the explicit **电脑上的 Herdr 没有运行** state means Herdr is closed. You can run `pairfobd doctor` on the computer to confirm.

**新建** appears in the top bar when the computer declared `create_conversation`. The form can start a supported agent, or a **纯终端** pane with no agent — useful when the tool you need is not in `agent_kinds`, or you want to drive the PTY yourself. With no kinds the dialog still opens and creates that terminal session.

## Inside a session

Opening a session lands in **控制**: the computer’s already-rendered pane, operated on the phone. Not a remote-desktop screenshot, not a terminal emulator in the browser.

Chrome:

- Left: back to the list (phone)
- Center: name and status; tap to switch sessions
- While working, an interrupt control sends Esc to the PTY
- Right: `···` more actions

The three modes are under `···` → **模式**. A switch inside a session is remembered for that session only. The default for newly opened sessions is in **设置**.

| Mode | What it is |
| --- | --- |
| **控制** | Phone UI for this session: tappable TUI choices, system keyboard into the local PTY |
| **终端** | A real terminal. Use for vim or a full-screen TUI. On a phone the default is an 80-column PTY you pan sideways; **适应屏幕** resizes the computer to the phone width. Vertical pan still scrolls the remote TUI |
| **对话** | Message the Agent (this is where you send a task; it is not a `···` menu item). The run collapses after the reply; the reply is Markdown |

In **控制**:

- The compose box uses the **system keyboard**, including dictation and autocorrect. **组字 / 实时** switches sit above the field
- TUI choices become tappable buttons — **Enter is not fired blindly**
- Tapping a row can copy the line, copy a path, quote into compose, or start text selection
- Swipe or 页↑ pages the live TUI; it does not dump scrollback
- Font size is roughly 9–22px and is remembered
- Long lines can wrap or not

A dialog confirmed on the computer is already confirmed on the phone, and the reverse. There is no phone-side draft and no “pending sync” queue.

## Actions that may appear in the menu

Tap `···`. Missing items are not drawn. Authority is the computer’s [eleven capabilities](/capabilities).

| Group | May include |
| --- | --- |
| 模式 | 控制, 终端（vim / TUI）, 对话 |
| 输入 | 组字, 实时 (控制) |
| 显示 | 长行自动折行 (控制), 宽度 适应屏幕 / 80 列 (终端), 选择文本, 文字加大/减小, 复制画面文本, 更早的输出 |
| 新建 | 新建标签页, 分屏 |
| Worktree | Worktree 列表, 新建 Worktree, 打开 Worktree |
| 布局 | 让这一格大一点, 和对面一格对调 |
| 管理 | 改会话名, 改标签页名, 改工作区名, 关闭这个会话 / 整个标签页 |

Path operations must stay inside the live snapshot root or the computer’s allowed roots. Failure is closed; the UI does not fake success. **更早的输出** fetches already-rendered, idle scrollback collected on the computer; the phone cannot submit a path, transcript id, source, or arbitrary line count. A busy or scrolled-away terminal must become idle first. **对话** groups thinking and tools into a collapsible run that closes once the reply is in, and renders that reply as Markdown. Expand the run to see arguments and results.

The web surface **does not** offer: arbitrary shell, environment injection, deleting worktrees, stealing focus, or a full `layout.apply`. Creation and layout always use `focus=false`, so the computer window is not yanked to the front.

## 设置

From the top-right of the list (**设置**).

- **连接:** computer name, online state, this phone’s label (for example iPhone). **添加另一台电脑** starts another pairing without replacing the current one. With more than one credential, **切换电脑** appears here and **电脑** appears in the top bar
- **会话列表:** grouping (**全部** / **按工作区** / **按 Agent**)
- **模式:** default when opening a session — **控制** / **终端** / **对话**. A later switch is remembered per session
- **输入:** send after composing, or type live into the terminal
- **通知:** see [Notifications](/push). Once enabled, this phone is notified when an Agent needs you or finishes; if the computer has not enabled push, it shows **电脑端未开启**
- **已配对设备:** label, last used, and notification state. The current row is marked **这台手机**. This phone can unpair only itself
- **危险操作:** **解除这台手机的配对**. Pairing is required to connect again

A lost phone that can still open Pairfob can at most kick itself; it cannot kick the rest of the household. Kick others with `pairfobd forget N` on the computer — [Multiple devices](/devices).

## Another window

If another browser window of the same paired device opens Pairfob, the old window may say **另一个窗口接管了这台手机**. Keep a single open page.

## Add to Home Screen

See [Get started](/start#add-to-home-screen). On iOS, prefer Safari → Add to Home Screen for daily use.
