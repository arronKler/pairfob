---
title: 中继看不到什么
description: 配对后端到端加密。relay 只转发密文。电脑只出站，不绑 Tailscale。
---

# 中继看不到什么

`pairfob.com` 是 relay，不是 VPN，也不跑 Herdr。配对完成之后，会话密钥只在你的设备和电脑上的 `pairfobd` 里。

## 中继能看见 / 不能看见

| 看不见 | 能看见（为了路由和限流） |
| --- | --- |
| pane 文本 | 内部路由标识（哪台 daemon、哪条连接） |
| 按键 | 密文长度 |
| RPC 内容 | 配对尝试是否过于频繁 |
| 设备密钥、PSK | 来源 IP（限流用 `CF-Connecting-IP`） |
| Herdr socket | enroll / 配对是否成功这类结果 |

relay 只按帧转发。它不解析会话里的 `FWD` 明文，也不实现 Herdr API。

信封标签是 `pairfob.v1`。Go 和浏览器实现对照同一组测试向量，不允许「差不多就行」的编码。

## 电脑只出站

`pairfobd` 主动连上来。家里不用开端口，也不绑 Tailscale。身份只在 daemon 上认：

- 不信任客户端自己报的 `device_id` 去放行
- 不把 Herdr 的 HTTP 或 Unix socket 暴露给中继
- 读和写都要求已经 `Established` 的会话

## 配对确认为什么在电脑上

手机证明配对码之后，只在电脑终端按 Enter 才真正放行。这是为了防止只拿到二维码的人在你不知情时配上。产品不再展示安全词。

扫码和手输都不会把配对秘密放到 URL 查询串里当长期令牌。定位码只用来找到电脑，不进入 SPAKE2+。

## 凭证在哪

| 位置 | 有什么 |
| --- | --- |
| 电脑 `~/.config/pairfob` | daemon 身份、reconnect、设备名单、操作账本、可选 VAPID。目录 `0700`，文件 `0600` |
| 这台设备的浏览器存储 | 这台设备的会话凭证。清站点数据 = 要重新配对 |
| `pairfob.com` | 登记与路由所需的不透明标识，没有 pane 明文 |

把状态目录当敏感凭据备份。不要提交到 git，不要发到聊天里。

登记不是账号密码。配对和重连凭据只在这台电脑和这台浏览器里。

## 不在保护范围内

Pairfob 不声称能防这些：

- 被改过的网站前端（你打开的是别人的假 Pairfob 页）——认准 `https://pairfob.com`
- 失窃且未清除、未吊销的手机浏览器存储
- 能在电脑本机读 Herdr 或 `~/.config/pairfob` 的人
- 已经解锁、站在你电脑终端前、替你按了 Enter 的人

## 出事时

1. 电脑上 `pairfobd list`，把不该在的设备 `forget`
2. 若怀疑 reconnect 泄露：`pairfobd relay rekey`，然后所有设备重新配对
3. 若电脑本身不干净：当作 Herdr 和本机密钥都已暴露，停掉服务，处理本机，再新装

不要把配对码、`relay.json`、`vapid.json` 贴进别人的页面。
