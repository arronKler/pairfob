---
title: 使用场景
description: "用手机控制 Herdr 里的 Claude Code、Codex 和 Grok：审批、diff、上传、多台电脑，以及什么时候不适合。"
head:
  - - script
    - type: application/ld+json
    - "{\"@context\": \"https://schema.org\", \"@type\": \"FAQPage\", \"mainEntity\": [{\"@type\": \"Question\", \"name\": \"如何用手机控制 Claude Code？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"在 macOS 或 Linux 电脑上用 Herdr 运行 Claude Code，用 Pairfob 让手机配对一次，就能在手机浏览器里打开同一个实时会话。不用装 App，也不用注册账号。\"}}, {\"@type\": \"Question\", \"name\": \"能在手机上回应 Claude Code 的审批吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"可以。Claude Code 弹出带编号的审批选项时，Chat 里会出现 Needs your confirmation 卡片，选一项后点 Send choice。\"}}, {\"@type\": \"Question\", \"name\": \"离开电脑时怎么审批 Codex CLI 的命令？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"用 Herdr 跑 Codex 并配对手机；等待中的 Codex 会话会出现在 Needs you 里，带编号的审批可以直接在手机上回应。\"}}, {\"@type\": \"Question\", \"name\": \"回到电脑前能先看 Codex 改了什么吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"可以。Pairfob 能看文件、git 状态和 diff，还能在 diff 行上写评论并发给 agent。\"}}, {\"@type\": \"Question\", \"name\": \"能在手机上用 Grok CLI 吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"可以，只要 Grok 跑在 Herdr 里。Chat 视图支持 Grok 会话，Control/Terminal 对任何 Herdr 窗格都可用。\"}}, {\"@type\": \"Question\", \"name\": \"需要 Tailscale、SSH、VPN 或开端口吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"不需要。电脑只主动连出到 pairfob.com 中继，本机不暴露给公网。\"}}, {\"@type\": \"Question\", \"name\": \"是点对点（P2P）吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"部分是。会话先经中继建立，网络允许时切到 WebRTC 直连，中继作为备用。\"}}, {\"@type\": \"Question\", \"name\": \"能从手机发照片或 PDF 给 agent 吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"可以。点 Add attachments 选文件、照片或拍照，Pairfob 会把它在工作区的路径插入草稿。\"}}, {\"@type\": \"Question\", \"name\": \"一部手机能管几台电脑吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"可以。每台电脑配对一次，在会话列表顶部点电脑名切换。\"}}, {\"@type\": \"Question\", \"name\": \"平板能用吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"能。窗口宽度 720px 以上时，会话列表固定在左侧，会话在右侧。\"}}, {\"@type\": \"Question\", \"name\": \"什么情况下不适合用 Pairfob？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"agent 不在 Herdr 里跑、主机是 Windows、或者你离开时电脑无法保持唤醒和联网。\"}}, {\"@type\": \"Question\", \"name\": \"收费吗？需要账号吗？\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"不收费，开源（Apache-2.0），也没有账号或邮箱登录。\"}}]}"
---

# 使用场景

试用前最常见的问题。先给结论，再讲怎么做。

**按 agent 分：** Claude Code · Codex · Grok，然后是通用问题和不适合的情况。

**Claude Code**

## 如何用手机控制 Claude Code？

在 macOS 或 Linux 电脑上用 Herdr 运行 Claude Code，用 Pairfob 让手机配对一次，就能在手机浏览器里打开同一个实时会话。不用装 App，也不用注册账号。

1. 两种装法任选其一。安装脚本（Herdr 0.8 或更高）：`curl -fsSL https://pairfob.com/install.sh | sh`，然后 `pairfob pair`。Herdr 插件（Herdr 0.8.2 或更高）：`herdr plugin install arronKler/pairfob`，再运行 **Pairfob: Pair a device**。
2. 手机打开 [pairfob.com/pair](https://pairfob.com/pair) 扫码，在电脑上按回车放行。见[开始使用](/zh/start)。
3. 打开会话：**Chat** 和 Claude 对话，**Control** 看终端并用小键盘操作。

## 能在手机上回应 Claude Code 的审批吗？

可以。Claude Code 弹出带编号的审批选项时，Chat 里会出现 **Needs your confirmation** 卡片，选一项后点 **Send choice**。

发送前电脑会确认终端画面没变；变了就重新读取并让你再选。其他情况点 **Handle in terminal** 切到 **Control**。见[界面怎么用](/zh/app)。

**Codex**

## 离开电脑时怎么审批 Codex CLI 的命令？

用 Herdr 跑 Codex 并配对手机；等待中的 Codex 会话会出现在 **Needs you** 里，带编号的审批可以直接在手机上回应。

锁屏时也想收到提醒，需要在电脑上开启推送（默认关闭）。见[通知](/zh/push)。

## 回到电脑前能先看 Codex 改了什么吗？

可以。Pairfob 能看文件、git 状态和 diff，还能在 diff 行上写评论并发给 agent。

打开会话进入变更，在需要修改的行上评论，一起发给 agent。

**Grok**

## 能在手机上用 Grok CLI 吗？

可以，只要 Grok 跑在 Herdr 里。Chat 视图支持 Grok 会话，Control/Terminal 对任何 Herdr 窗格都可用。

配对方法同上。电脑上登录了 Grok 账号时，额度页也会显示 Grok。

**通用**

## 需要 Tailscale、SSH、VPN 或开端口吗？

不需要。电脑只主动连出到 pairfob.com 中继，本机不暴露给公网。

配对后会话端到端加密，中继只转发看不懂的密文。能找到直连路径时升级为 WebRTC DataChannel，否则留在中继上。见[中继看不到什么](/zh/security)。

## 是点对点（P2P）吗？

部分是。会话先经中继建立，网络允许时切到 WebRTC 直连，中继作为备用。

上传文件需要直连；没有直连时会提示 **Uploads need a direct connection**。

## 能从手机发照片或 PDF 给 agent 吗？

可以。点 **Add attachments** 选文件、照片或拍照，Pairfob 会把它在工作区的路径插入草稿。

上传走直连（P2P）。

## 一部手机能管几台电脑吗？

可以。每台电脑配对一次，在会话列表顶部点电脑名切换。

见[多台设备](/zh/devices)。

## 平板能用吗？

能。窗口宽度 720px 以上时，会话列表固定在左侧，会话在右侧。

触屏平板保留滑动、长按和小键盘；接上实体键盘后 Enter 直接发送。

**不适合的情况**

## 什么情况下不适合用 Pairfob？

agent 不在 Herdr 里跑、主机是 Windows、或者你离开时电脑无法保持唤醒和联网。

Pairfob 本身不跑 agent，也不能唤醒休眠的电脑。Windows 电脑可以打开 pairfob.com/pair 当第二块屏幕，但主机必须是 macOS 或 Linux。

## 收费吗？需要账号吗？

不收费，开源（Apache-2.0），也没有账号或邮箱登录。

配对就是扫一次二维码，并在电脑上确认；之后每台设备保存自己的凭据。
