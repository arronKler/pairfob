---
title: 术语
description: Herdr、pane、pairfobd、定位码这些词在 Pairfob 里指什么。
---

# 术语

| 词 | 意思 |
| --- | --- |
| Herdr | 电脑上跑 coding agent 的本机程序。Pairfob 不替代它。需要 0.7 或更高 |
| pane | 已经渲染好的那一块会话画面 |
| 控制 | 手机上操作这个会话：选项可点，系统键盘打回 PTY。默认模式 |
| 终端 | 真终端（xterm）。vim、全屏 TUI 才需要 |
| 对话 | 和 Agent 发消息。执行过程可展开，回复按 Markdown 渲染 |
| PTY | 电脑上接键盘输入的那个伪终端。手机按键打到这里 |
| pairfobd | 这台电脑上的 Pairfob 后台进程，只出站，只和本机 Herdr 说话 |
| join token / `PAIRFOB_JOIN_TOKEN` | 已移除。不要设 |
| origin | 网页和 WebSocket 的那个 HTTPS 主机，托管是 `https://pairfob.com` |
| 配对码 | 8 位，秘密，用于配对密码学 |
| 定位码 | 6 位，只用来找到那台电脑，不是秘密的同类物 |
| 电脑确认 | 手机证明配对码后，只在电脑终端按一次 Enter 才放行 |
| relay | `pairfob.com` 上的 Worker，转发密文，不看 pane |
| PWA | 浏览器里的 Pairfob 页面，可以加到主屏幕。路径是 `/pair` |
| Established | 配对并确认之后的会话状态。读和写都要求这个状态 |
| `PAIRFOB_STATE_DIR` | 默认 `~/.config/pairfob`，凭据和设备名单 |
| operation_id | 每一次改动的新鲜标识。不是重试令牌 |
| `unknown_outcome` | 电脑可能已经执行也可能没有。只刷新，不重放 |
| capabilities | 十一项互相独立的布尔值，决定界面画哪些控件 |
| worktree | Git worktree。列出 / 创建 / 打开以 live Herdr 为准 |
| VAPID | Web Push 用的密钥对。默认不生成，直到打开推送 |
