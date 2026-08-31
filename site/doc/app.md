---
title: Using the app
description: List, open a session, system keyboard, tappable dialogs. Controls appear only when the computer supports them.
---

# Using the app

Pairfob opens on the session list from the computer. Tapping a card opens that session, not a copy and not a screenshot.

The app chrome is currently Chinese. Labels below are the strings on screen.

Wide layouts (roughly a landscape tablet or a desktop browser) use two columns: list on the left, session on the right. Phones are one screen at a time. Swipe right from the left edge of a session to return to the list.

## The list

The default is a flat list, ordered by recent activity (create, status change, open). In **设置**, grouping is:

- **全部** — one list
- **按工作区** — Herdr workspaces
- **按 Agent** — agent kinds

Grouped headings toggle open and closed. The first group starts open; the rest start collapsed.

The card title is the task identity: the session name if you set one; otherwise the workspace name when it is not just the directory name; otherwise a task-like terminal title (stripping live crumbs such as `Thinking` / `Waiting for response` and a trailing ` - grok`). If none of those exist, it shows **claude · pairfob** (“Agent · folder”), or **终端 · pairfob** for a shell. The next line is coordinates (workspace, Agent, a renamed tab, directory), omitting words already in the title and default tabs such as `main`. Internal IDs are never presented as names.

- **会话名** names this terminal surface only.
- **标签页名** names the tab containing one or more sessions.
- **工作区名** names the outer project container and becomes the heading when grouped by workspace.

| Label | Meaning |
| --- | --- |
| 等你 | The agent is waiting for confirm or input; the card is emphasized |
| 工作中 | Running |
| 空闲 | Connected, not busy |
| 完成 | This turn finished |

When Pairfob is connected, an empty list means there are no sessions yet; create one or open a terminal on the computer. Only the explicit **电脑上的 Herdr 没有运行** state means Herdr is closed. You can run `pairfob doctor` on the computer to confirm.

**新建** appears in the top bar when the computer supports creating a session. The form can start a supported agent, or a **纯终端** pane with no agent. With no kinds listed, the dialog still opens and creates that terminal session.

The card body opens the session. The trailing `···` is for this session: rename it, close it. A tab id offers 改标签页名; a split tab also offers 关闭整个标签页. 改工作区名 is here too, in every grouping mode.

## Inside a session

Opening a session lands in **控制**: the session already open on the computer, operated on the phone. Not a remote-desktop screenshot, not another terminal in the browser.

Chrome:

- Left: back to the list (phone)
- Center: name and status; tap to switch sessions
- While working, an interrupt control is the same as Esc
- Right: `···` **这一屏** (how this view looks and types, this pane's name, close this pane)

The three modes are under `···` → **模式**. A switch inside a session is remembered for that session only. The default for newly opened sessions is in **设置**.

| Mode | What it is |
| --- | --- |
| **控制** | Phone UI for this session: tappable choices, system keyboard |
| **终端** | A real terminal. Use for vim or a full-screen TUI. On a phone the default is an 80-column view you pan sideways; **适应屏幕** resizes the computer to the phone width. Vertical pan still scrolls remotely |
| **对话** | Message the Agent (this is where you send a task; it is not a `···` menu item). The run collapses after the reply |

In **控制**:

- The compose box uses the **system keyboard**, including dictation and autocorrect. **组字 / 实时** switches sit above the field
- Choices become tappable buttons; empty Enter cannot stand in for tapping them
- The trailing control is **Enter**: with no draft it is a terminal Return; with a draft it types then confirms
- Tapping a row can copy the line, copy a path, quote into compose, or start text selection
- Swipe or 页↑ pages the live view; it does not dump history
- Font size is remembered
- Long lines can wrap or not

A dialog confirmed on the computer is already confirmed on the phone, and the reverse. There is no phone-side draft and no “pending sync” queue.

## Actions that may appear on this view

Tap the session chrome `···`. Missing items are not drawn. 改标签页名, 改工作区名, and 关闭整个标签页 live on the list card `···`, not here.

| Group | May include |
| --- | --- |
| 模式 | 控制, 终端（vim / TUI）, 对话 |
| 输入 | 组字, 实时 (控制) |
| 显示 | 长行自动折行 (控制), 宽度 适应屏幕 / 80 列 (终端), 选择文本, 文字加大/减小, 复制画面文本, 更早的输出. **对话** does not show this group |
| 新建 | 新建标签页, 分屏 |
| Worktree | Worktree 列表, 新建 Worktree, 打开 Worktree |
| 布局 | 让这一格大一点, 和对面一格对调 |
| 这一格 | 改会话名, 关闭这个会话 |

**更早的输出** is already-rendered, idle scrollback on the computer. A busy or scrolled-away terminal must become idle first. **对话** groups thinking and tools into a collapsible run that closes once the reply is in. Expand the run to see arguments and results.

The web surface does not offer arbitrary shell, deleting worktrees, or yanking the computer window to the front.

## 设置

From the top-right of the list (**设置**).

- **连接:** computer name, online state, this phone’s label (for example iPhone). **添加另一台电脑** starts another pairing without replacing the current one. With more than one credential, **切换电脑** appears here and **电脑** appears in the top bar
- **会话列表:** grouping (**全部** / **按工作区** / **按 Agent**)
- **模式:** default when opening a session — **控制** / **终端** / **对话**. A later switch is remembered per session
- **输入:** send after composing, or type live into the terminal. The trailing button only submits composed text; use the system keyboard or keypad for a deliberate bare Enter
- **通知:** see [Notifications](/push). Once enabled, this phone is notified when an Agent needs you or finishes; if the computer has not enabled push, it shows **电脑端未开启**
- **已配对设备:** label, last used, and notification state. The current row is marked **这台手机**. This phone can unpair only itself
- **危险操作:** **解除这台手机的配对**. Pairing is required to connect again

A lost phone that can still open Pairfob can at most kick itself; it cannot kick the rest of the household. Kick others with `pairfob forget N` on the computer — [Multiple devices](/devices).

## Another window

If another browser window of the same paired device opens Pairfob, the old window may say **另一个窗口接管了这台手机**. Keep a single open page.

## Add to Home Screen

See [Get started](/start#add-to-home-screen). On iOS, prefer Safari → Add to Home Screen for daily use.
