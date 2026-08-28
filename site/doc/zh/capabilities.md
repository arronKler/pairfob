---
title: 能力从哪来
description: 控件只看正在跑的 Herdr 实际支持什么。十一项各自开关，没有聚合别名。
---

# 能力从哪来

Pairfob 不另做一套手机专用命令。界面上的新建、分屏、worktree 等，以电脑上**正在跑的** Herdr 为准。

新装的 Herdr CLI 不会让旧的 Herdr 服务突然多出能力。不支持的操作会在动手之前失败（界面类似「当前 Herdr 版本还不支持这个操作」），而不是发出去再报错。

## 十一项开关

权威是一次配置读取里的十一项布尔值，必须都在，而且互相独立。没有 `worktrees`、`layout` 这种聚合开关。一项没有，不会把旁边已支持的也藏掉。

| 键 | 界面上的意思 |
| --- | --- |
| `create_conversation` | 新建会话 |
| `create_tab` | 新建标签页 |
| `split_pane` | 分屏 |
| `prompt_agent` | 向检测到的 agent 发提示 |
| `history` | 可信对话历史和有上限的终端渲染历史，均由电脑采集 |
| `list_worktrees` | 列出 worktree |
| `create_worktree` | 创建 worktree |
| `open_worktree` | 打开 worktree |
| `resize_pane` | 让这一格大一点 |
| `swap_pane` | 和对面一格对调 |
| `zoom_pane` | 铺满这一格（电脑上的分屏全屏） |

可选的 agent 种类同样来自正在跑的服务（`agent_kinds`），不在手机上写死「支持 Codex / Claude / Grok」名单。这些种类只用于启动 Agent。只要 `create_conversation` 为真，顶部 **新建** 就可以用；不选种类则创建纯终端 pane。

## 路径

网页提交的路径和当前工作目录必须落在：

- 当前 live snapshot 里的 workspace / pane 根，或
- 电脑上允许的根目录 `PAIRFOB_ALLOWED_ROOTS`

规则：

- **未设置** `PAIRFOB_ALLOWED_ROOTS`：默认是这台电脑用户的 Home
- **显式设置**：替换这个默认，不再自动带上 Home
- **显式空值**：只留下当前 Herdr 根
- 必须是绝对、已存在、能规范化的目录；相对路径、不存在、解析失败 → 启动或操作 fail-closed
- 新建 worktree 的目标可以是某个 live checkout 的**直接兄弟目录**（父目录相同）。这只授权新目录，不把父目录变成通用 cwd 根

非法、相对、或逃出根的路径会失败，而不是改去猜一个成功结果。

Unix 上多项用冒号分隔，例如：

```sh
PAIRFOB_ALLOWED_ROOTS=/Users/me/src:/Volumes/work
```

## 操作怎么落地

每一次改动都带一枚新鲜的 `operation_id`。它不是「再试一次」的指令，也不能拿去套另一套参数。

- Pairfob **不会**自动重试 mutation
- 若结果是 `unknown_outcome`（例如进程在半路重启）：只刷新画面，**不重放**
- 界面可能写：「电脑可能已经执行了操作。请先刷新确认，不要立即重试」
- 已经打开的 worktree 再打开一次、或布局没有变化，会成功但标成 `noop`，不会伪造新的 pane

电脑在动手之前会把意图记到操作账本里。崩溃恢复时，未完成的记录当成未知结果，绝不自动再执行一遍。

## 网页故意没有的能力

- 任意命令、注入环境变量
- 删除 / 强制删除 worktree
- 抢焦点（所有创建和布局都 `focus=false`）
- 无限制的整页 layout 覆盖
- 管理 Herdr 的 server / plugin / 集成
- 让手机指定 transcript 路径来读历史

这些不是「还没做的按钮」，是产品边界。
