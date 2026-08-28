---
title: 怎么接起来
description: 手机只连 pairfob.com。电脑上的 pairfobd 出站接上 relay，再在本机回环上跟 Herdr 说话。
---

# 怎么接起来

用户能看见的只有三样：网页、电脑上的一个后台进程、以及你本来就在用的 Herdr。中间的 relay 不跑 agent。

```
手机 / 平板 / 另一台电脑上的 Pairfob（PWA）
        │
        │  HTTPS 静态资源（/、/pair、/doc）
        │  WSS 会话（密文）
        ▼
   pairfob.com
   营销页 · 文档 · 网页应用 · 帧级 relay
        ▲
        │  长连接，电脑主动出站
        │
   pairfobd（只在你的电脑上）
        │
        │  本机回环 / Unix socket
        ▼
      Herdr  →  Codex / Claude / Grok 的真实 PTY
```

## 每一段负责什么

| 段 | 做什么 | 不做什么 |
| --- | --- | --- |
| 网页应用 `/pair` | 配对、列表、画 pane、系统键盘、把按键和按钮变成 RPC | 不跑 agent，不存你的源码 |
| `pairfob.com` | 提供网页；把密文帧转到对应的电脑；登记电脑 | 不解析会话内容，不碰 Herdr |
| `pairfobd` | 持有身份和密钥；出站；把 RPC 变成对 Herdr 的调用 | 不在公网监听 |
| Herdr | 真正的会话、PTY、agent | 不知道手机这回事 |

公网路径 default-deny。客户端声称的设备名只是标签，不能拿来放行。

## 协议

信封与密码学是 `pairfob.v1`。mux 是 `pairfob.v2`：定位码、pair ticket、每台 daemon 一个房间。**不要**设 `PAIRFOB_JOIN_TOKEN`。一台 `pairfobd` 连 `pairfob.com`。

## 网页怎么落到同一域名

`https://pairfob.com/` 是介绍页，`/doc` 是这份文档，`/pair` 是应用。二维码和手输都指向这个 origin，所以配对不会跳到第三个域名。

电脑永远主动连出来。家里的防火墙只要允许访问 `pairfob.com` 的 HTTPS 即可。

## 想对照源码时

仓库里的冻结面是 `proto/envelope.md`、`proto/rpc.schema.json` 和向量文件。文档不重复那些字段名，以免和实现漂成两套。协议或跨语言原语变了，以向量和 schema 为准，而不是以这一页的示意图为准。
