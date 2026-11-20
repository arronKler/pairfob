---
title: 安装
description: install.sh 会下载 pairfob、核对校验和、登记，并装上登录即启动的用户服务。
---

# 安装

安装从本项目官方实例 `https://dl.pairfob.com/daemon` 拉二进制。需要 `curl`。支持 macOS 和 Linux。Windows 会直接拒绝。

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

第二台电脑也是这条命令。装好后在手机上：**设置 → 切换电脑 → 添加电脑**。不要设 `PAIRFOB_JOIN_TOKEN`。

Pairfob 不会安装或登录 AI Agent。使用前请先在电脑上安装并登录所选 Agent；也可以在配对后选择终端，无需 Agent。

## Herdr 检查与安装

安装器会先检查 Herdr，再替换已有 Pairfob、登记和安装服务。已有可用的 Herdr 会直接复用；已安装但未运行时会自动启动，并等待接口就绪。缺少 Herdr 时自动下载最新稳定版，核对 SHA-256 后安装到 `~/.local/bin/herdr`，记录安装来源，不覆盖已有 Herdr。

无交互安装使用以下命令，缺少 Herdr 时同样会自动补装：

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --non-interactive
```

`--non-interactive` 禁止询问，仍默认补齐缺少的 Herdr。使用 `--no-install-herdr` 可在缺失时直接失败。`--skip-herdr-check` 可用于仅安装或离线准备，但不会显示会话已就绪。`--no-service` 不代表跳过 Herdr 检查；离线拷贝使用 `--no-service --no-enroll --skip-herdr-check`。

安装后可运行 `pairfob setup` 再检查并启动 Herdr，或 `pairfob setup --install-herdr` 补齐缺少的依赖。`pairfob doctor` 只诊断，不安装、不启动。旧协议、启动失败、无效的 `HERDR_BIN` 或 socket 配置都需要修复后再继续；不会自动升级或重启已有 Herdr 会话。Pairfob 只自动启动默认服务；设置 `PAIRFOB_HERDR_AUTOSTART=0` 时，需要自行启动配置的 Herdr 服务。自动启动的限制见 [命名 Herdr 会话](/zh/app#命名-herdr-会话)。

## 脚本实际做了什么

1. 按当前系统下载对应的 `pairfob`
2. 核对校验和，对不上就失败，不会覆盖已有文件
3. 检查 Herdr，缺失时自动安装并启动，验证接口就绪
4. 完成登记
5. 除非 `--no-service`，否则装上登录即启动的**用户级**服务

## 参数

| 参数 | 作用 |
| --- | --- |
| `--prefix DIR` | 安装目录。可写的 `/usr/local/bin` 时用那里，否则 `~/.local/bin` |
| `--no-service` | 只装二进制和登记，不装登录服务 |
| `--no-enroll` | 跳过登记；不会自动跳过服务或 Herdr 检查 |
| `--no-install-herdr` | 缺失时失败，不下载依赖 |
| `--install-herdr` | 兼容参数：缺少 Herdr 时自动安装（默认行为） |
| `--non-interactive` | 禁止交互询问；默认补齐 Herdr，除非明确禁止安装 |
| `--skip-herdr-check` | 跳过 Herdr 检查，不声明会话就绪 |

也可以：

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --prefix "$HOME/bin"
```

已经登记过的机器再跑一遍安装脚本会换成新二进制，并留下原来的配对关系。

服务会保存安装检查时选用的 Herdr 可执行文件及 socket、配置路径和启动选项，避免登录后的 PATH 差异导致连接失败。

安装器从用户主目录检查和启动 Herdr，与登录服务一致；相对 Herdr 配置路径也以主目录为基准。

## 装到哪里

| 条件 | 二进制 |
| --- | --- |
| `/usr/local/bin` 可写 | 默认 `/usr/local/bin/pairfob` |
| 普通用户 | 默认 `~/.local/bin/pairfob` |

文档统一使用 `pairfob`。安装器还会在同一目录创建兼容别名 `pairfobd → pairfob`。

若 `~/.local/bin` 不在 `PATH` 里，安装脚本会提醒你加进去，例如 zsh：

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## 装完之后

登录一次之后，服务会自己起来。这是登录级服务，不是开机守护进程：睡眠和注销会停掉，回到同一次图形会话后再起来。在终端运行 `pairfob` 会显示状态，并建议对应的恢复命令。前台运行使用 `pairfob run`。查看或重启已安装的服务：

```sh
pairfob service status
pairfob service restart
```

日常不需要碰这些。`pairfob update` 会换成新二进制并重启已安装的用户服务。

## 在外面用手机连接 Mac 桌面

在 macOS 13 及以上版本，交互式安装会询问是否开启远程桌面。已安装或当时选了「稍后设置」，可以在 Mac 上运行 `pairfob desktop setup`。选好显示器和「仅允许查看」或「允许查看和控制」，然后按系统提示授予屏幕录制权限。控制键盘和鼠标还需要辅助功能权限。离开前可运行 `pairfob desktop status` 检查直连开关、系统权限、锁屏状态和所选显示器。手机能否直连还取决于当时的两端网络。

之后，从已配对手机的电脑详情页打开「远程桌面」即可连接。此设置适用于当前和以后配对的设备，重连时无需在 Mac 上确认。Mac 需要保持唤醒、已解锁，并与手机建立 P2P 直连。结束当前共享后可以再次连接。如要持续关闭这项功能，在 Mac 上运行 `pairfob desktop disable`。

如果 Mac 长时间插电并且你希望离开后仍能连接，可在授权后运行 `pairfob desktop standby-on`。Pairfob 会在外接电源时阻止系统因空闲而睡眠，拔下电源或运行 `pairfob desktop standby-off` 即恢复正常。显示器仍可熄屏。若系统仍醒着且账户已解锁，发起远控时会尝试唤醒所选显示器。自动锁屏策略继续生效；系统睡眠、锁屏与重启后的首次登录可使用[独立恢复控制台](./mac-recovery)。

## 更新

```sh
pairfob update
```

换成最新版本并重启用户服务。不要把安装脚本再跑一遍当「更新」。

## 卸载

```sh
pairfob service uninstall
prefix="$(dirname "$(command -v pairfob)")"
rm -f "$prefix/pairfob" "$prefix/pairfobd"
```

只卸服务不会删状态目录。若要连配对关系一起忘掉，再删 `~/.config/pairfob`（先确认你不再需要那些设备凭证）。

## 从源码跑

适合本机对照。仓库在 [arronKler/pairfob](https://github.com/arronKler/pairfob)。先运行一次 setup 自动准备 Herdr。日常使用还是上面的安装命令。

```sh
go run ./cmd/pairfob setup
go run ./cmd/pairfob
```

本地配对和校验见仓库 README。

<span id="herdr-runtime"></span>

## Herdr 运行组件更新

`pairfob update` 和网页里的“更新到 v…”只更新 Pairfob。Pairfob 安装并能确认来源的 Herdr 使用：

```sh
pairfob setup --update-herdr
```

正在运行时只下载并校验，退出码 2 表示已准备但未生效，任务保持运行。选择可以中断任务的时间，在电脑上执行：

```sh
pairfob setup --update-herdr --restart-herdr
```

命令会列出目标和影响，在终端确认后停止默认服务、更新并验证。停止会终止终端进程，Agent 可能需要恢复；回退二进制不能恢复这些进程。命名会话、自定义 socket、外部管理的服务需先按原方式维护。无交互终端不能授权重启。

Homebrew、mise、Nix 或来源不明的 Herdr 使用原安装方式更新；旧版 Pairfob 未记录来源的安装也不会自动接管。`pairfob doctor` 显示文件版本、运行版本和暂存状态。卸载 Pairfob 默认保留 Herdr、会话和项目。
