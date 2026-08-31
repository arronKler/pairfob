---
title: 术语
description: Herdr、pane、pairfob、定位码这些词在 Pairfob 里指什么。
---

# 术语

| 词 | 意思 |
| --- | --- |
| Herdr | 电脑上跑 coding agent 的本机程序。Pairfob 不替代它。需要 0.7 或更高 |
| pane | 已经打开的那一块会话画面 |
| 控制 | 手机上操作这个会话：选项可点，系统键盘。默认模式 |
| 终端 | 真终端。vim、全屏 TUI 才需要 |
| 对话 | 和 Agent 发消息。执行过程可展开 |
| pairfob | 这台电脑上的 Pairfob 后台进程，只往外连，只和本机 Herdr 说话 |
| 配对码 | 8 位，秘密 |
| 定位码 | 6 位，只用来找到那台电脑，不是秘密的同类物 |
| 电脑确认 | 手机证明配对码后，只在电脑终端按一次 Enter 才放行 |
| relay | `pairfob.com`，转发密文，不看会话 |
| PWA | 浏览器里的 Pairfob 页面，可以加到主屏幕。路径是 `/pair` |
| `PAIRFOB_STATE_DIR` | 默认 `~/.config/pairfob`，凭据和设备名单 |
| worktree | Git worktree。列出 / 创建 / 打开以电脑当时为准 |
