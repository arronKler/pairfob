---
title: 环境变量
description: 安装、登记、路径根、推送。不要设 PAIRFOB_JOIN_TOKEN。
---

# 环境变量

只列操作时会碰到的变量。未说明的保持不设。不要把密钥写进全局 `~/.zshrc` 再随手贴日志。

## 登记和站点

| 变量 | 何时用 |
| --- | --- |
| `PAIRFOB_ORIGIN` | 缺省 `https://pairfob.com`（本项目官方实例）。不要改 |
| `PAIRFOB_JOIN_TOKEN` | **禁止**。设了会启动失败 |

## 本机状态

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PAIRFOB_STATE_DIR` | `~/.config/pairfob` | 身份、设备、日志 |
| `PAIRFOB_ALLOWED_ROOTS` | 用户 Home | 网页路径允许的根。显式设置会替换 Home；显式设为空则不允许任何网页路径。`pairfob service install` 会保留该设置 |
| `PAIRFOB_MULTI_SESSION` | 开 | 手机可在会话列表顶部和设置里列出并切换命名 Herdr 会话（`herdr --session <name>`）。`0` 时关闭；`HERDR_SOCKET_PATH` 设置为非默认路径时保持关闭，除非设置为 `1`。Pairfob 仍只自动启动默认服务；通知仍只来自默认会话。见 [命名 Herdr 会话](/zh/app#命名-herdr-会话) |

## 安装

| 变量 | 说明 |
| --- | --- |
| `PAIRFOB_DOWNLOAD_BASE` | 二进制下载根，默认 `https://dl.pairfob.com/daemon` |
| `PAIRFOB_INSTALL_PREFIX` | 安装前缀，等同 `install.sh --prefix` |

## 推送

| 变量 | 说明 |
| --- | --- |
| `PAIRFOB_PUSH` | 默认 `1`（开启），`0` 关闭 |
| `PAIRFOB_VAPID_SUBJECT` | 可选：你控制的 `mailto:` 或 `https:` 地址，默认 `https://pairfob.com` |

用 `PAIRFOB_PUSH=0 pairfob service install` 保存关闭设置（`1` 开启）。重装保留已有推送设置，普通重启不会导入当前终端的环境变量。见 [通知](/zh/push)。

## 保持关掉

| 变量 | 为什么 |
| --- | --- |
| `PAIRFOB_HERDR_AUTOSTART` | `0` 时不自动拉起 Herdr |
| `PAIRFOB_DEV_FAKE_RUNTIME` | 演示数据，不是真 Herdr |
| `PAIRFOB_DEV_AUTO_ADMIT` | 跳过电脑上的配对确认。隔离测试以外等于把电脑送给任何拿到码的人 |
