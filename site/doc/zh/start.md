---
title: 开始使用
description: 电脑装好 Herdr 和 pairfobd，配对一次就能在另一台设备上接着操作。
---

# 开始使用

托管入口是 `https://pairfob.com`。电脑必须能打开本机 Herdr。目前支持 macOS 和 Linux，Windows 还不支持。

做完这四步，就可以在另一台设备上看到电脑上的会话：安装 Herdr → 安装 Pairfob → 配对 → 点进列表。

## 你需要什么

| 需要 | 说明 |
| --- | --- |
| 一台 macOS 或 Linux 电脑 | `pairfobd` 跑在这里，agent 也跑在这里 |
| [Herdr](https://herdr.dev) 0.7 或更高 | Pairfob 不自带 agent，也不代替 Herdr |
| `curl` | 安装脚本用来下载二进制 |
| 另一台设备的浏览器 | 手机、平板，或另一台电脑都可以 |

不要设置 `PAIRFOB_JOIN_TOKEN`。relay 只有 Worker；设了会启动失败。

## 1. 电脑上装好 Herdr

Pairfob 不代替 Herdr。agent 仍在这台电脑上跑，但安装 Pairfob 前不需要先打开 Herdr。默认单会话下，`pairfobd` 启动时发现 Herdr 不在线，就会无感启动持久 Herdr server。你之后照常运行 `herdr`，会附着到同一个 server，手机上已经打开的 pane 和进程不会变成副本。

如果自动启动失败，手机会明确提示 Herdr 没有运行；在电脑执行一次 `herdr` 后会自动恢复，不用重启 Pairfob 或重新配对。不想让 Pairfob 自动启动 Herdr 时，可给服务设置 `PAIRFOB_HERDR_AUTOSTART=0`。不必为 Pairfob 做一个额外的「远程模式」。

## 2. 安装 pairfobd

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

这会：

1. 按当前系统下载对应的 `pairfobd`（darwin/linux × amd64/arm64）
2. 核对 SHA-256，对不上就失败，不会装上
3. 向 `https://pairfob.com` 登记（enroll）
4. 装上登录即启动的用户服务（macOS LaunchAgent / Linux systemd --user）

这是登录后启动，不是开机就活。合盖睡眠或注销会停掉，回到同一次图形会话后再起来。

装完以后启动复用本机 `relay.json`。第二台电脑也是这条命令，然后在手机上 **设置 → 添加另一台电脑**。

参数、安装位置、如何卸载见 [安装](/zh/install)。

源码目录里也可以先跑起来（不会装用户服务）：

```sh
go run ./cmd/pairfobd
```

装好后直接敲 `pairfobd`（后面不跟子命令），它会用一段人话告诉你：在不在跑、配了对几台、Herdr 开没开。更完整的检查用 `pairfobd doctor`。

## 3. 配对

在**跑 pairfobd 的那台电脑**的终端里：

```sh
pairfobd pair
```

它会优先画出二维码，并保留一串给手输用的码。另一台设备打开 <a href="/pair">pairfob.com/pair</a>：

- **能扫码**：直接扫，开始配对
- **不能扫**：展开手输。必须是 **8 位配对码 + 6 位定位码**（可以一次粘贴 14 个字符）

电脑提示对端已经验证之后，在终端里按一次 **Enter**。这是授权，不是账号登录。两边都不会显示安全词。

细节、过期和报错见 [配对](/zh/pair)。

## 4. 点进去

Herdr 里的会话会出现在 Pairfob 列表里。点一张卡片，打开的是电脑上那个 pane，不是副本。

状态是「等你」时，TUI 选项会抬成可点的按钮，**不会替你盲发 Enter**。底部输入框用系统键盘，听写和自动更正都还在。发出去的字进的是电脑上那个真实 PTY。

界面说明见 [手机上怎么用](/zh/app)。出门再打开、坐回来不用同步，见 [出门和回来](/zh/continue)。

## 加到主屏幕

Pairfob 是网页应用（PWA），可以加到主屏幕，下次少一层浏览器地址栏。

**iOS / iPadOS（Safari）**

1. 打开 <a href="/pair">pairfob.com/pair</a>（已配对后会直接进列表）
2. 分享 → 添加到主屏幕
3. 以后从图标打开

设计上 iOS 建议走主屏幕；只停在 Safari 标签里也能用，但通知和全屏会受限。

**Android（Chrome）**

浏览器可能会提示「安装应用」，也可以菜单 → 安装应用 / 添加到主屏幕。

凭证在**这台设备的这个浏览器配置**里。换浏览器、清站点数据、或 iOS 上用「无痕」等于要重新配对。

## 怎样算成功

| 在电脑上 | 在手机上 |
| --- | --- |
| `pairfobd doctor` 里 Running / Herdr / Origin 都正常 | 打开就能看到同一份会话列表 |
| `pairfobd list` 能看到这台设备 | 点进「等你」的卡片，对话框可点 |
| 电脑 Herdr 窗口还在，布局没被抢走焦点 | 打的字出现在电脑那个 pane 里 |

下一步可以看 [多台设备](/zh/devices)、[通知](/zh/push)，或先把 [常见问题](/zh/faq) 扫一遍。
