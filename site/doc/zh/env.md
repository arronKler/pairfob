---
title: 环境变量
description: 安装、登记、路径根、推送。不要设 PAIRFOB_JOIN_TOKEN。
---

# 环境变量

只列操作者会碰到的。改这些不会让你「多一种 RPC」，也不会放宽路径检查。

未说明的变量保持 unset。不要把密钥写进全局 `~/.zshrc` 再随手贴日志。

## 登记和 origin

| 变量 | 何时用 |
| --- | --- |
| `PAIRFOB_ORIGIN` | HTTPS 源。缺省 `https://pairfob.com`。不要改 |
| `PAIRFOB_RELAY_WS` | 少数情况覆盖 WebSocket URL。能不设就不设 |
| `PAIRFOB_JOIN_TOKEN` | **禁止**。设了会启动失败 |
| `PAIRFOB_JOIN_GRANT` | 产品路径不用。安装脚本会自己登记 |

## 本机状态

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PAIRFOB_STATE_DIR` | `~/.config/pairfob` | 身份、reconnect、设备、日志、socket。目录 `0700` |
| `PAIRFOB_ADMIN_SOCK` | `$PAIRFOB_STATE_DIR/pairfobd.sock` | 本机管理口，必须是绝对路径 |
| `PAIRFOB_ALLOWED_ROOTS` | 用户 Home | 网页路径允许的根。显式设置会替换 Home；空值只留 Herdr 根。Unix 用 `:` 分隔 |

## 安装

| 变量 | 说明 |
| --- | --- |
| `PAIRFOB_DOWNLOAD_BASE` | 二进制下载根，默认 `https://pairfob.com/dl` |
| `PAIRFOB_INSTALL_PREFIX` | 安装前缀，等同 `install.sh --prefix` |

## 推送

| 变量 | 说明 |
| --- | --- |
| `PAIRFOB_PUSH` | `1` 才打开。默认关 |
| `PAIRFOB_VAPID_SUBJECT` | 你控制的 `mailto:` 或 `https:` URL |

用户服务不会自动继承你当前 shell 的环境。要让 LaunchAgent / systemd 看到它们，必须写进服务配置后再 `pairfobd service restart`。见 [通知](/zh/push)。

## 保持关掉

| 变量 | 为什么 |
| --- | --- |
| `PAIRFOB_MULTI_SESSION` | 默认 off。只有你明确要发现多路 Herdr session socket 时才开 |
| `PAIRFOB_DEV_FAKE_RUNTIME` | 演示数据，不是真 Herdr |
| `PAIRFOB_DEV_AUTO_ADMIT` | 跳过电脑上的配对确认。隔离测试以外等于把电脑送给任何拿到码的人 |
| `PAIRFOB_PAIR_CODE` | 进程一启动就开槽，留给自动化 |
| `PAIRFOB_PROTOCOL` | 若设了，只能是 `2`。能不设就不设 |

## 不要发明的东西

不要为了「好记」再设一层聚合开关，也不要把客户端声称的 `device_id` 写进环境来放行。能力以 live `GetConfig.capabilities` 十一键为准，见 [能力从哪来](/zh/capabilities)。
