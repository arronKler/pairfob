---
title: 安装
description: install.sh 会下载 pairfob、核对校验和、登记，并装上登录即启动的用户服务。
---

# 安装

安装从本项目官方实例 `https://pairfob.com/dl` 拉二进制。需要 `curl`。支持 macOS 和 Linux。Windows 会直接拒绝。

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

第二台电脑也是这条命令。装好后在手机上：**设置 → 添加另一台电脑**。不要设 `PAIRFOB_JOIN_TOKEN`。


## Herdr 检查与安装

安装器会先检查 Herdr，再替换已有 Pairfob、登记和安装服务。已有可用的 Herdr 会直接复用；已安装但未运行时会自动启动，并等待接口就绪。缺少 Herdr 时会在终端询问是否安装固定版本 0.8.2，核对 SHA-256 后安装到 `~/.local/bin/herdr`，不覆盖已有 Herdr。

无交互安装可明确允许补齐依赖：

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --install-herdr --non-interactive
```

`--non-interactive` 禁止询问；缺少 Herdr 且没有 `--install-herdr` 时失败退出。`--skip-herdr-check` 可用于仅安装或离线准备，但不会显示会话已就绪。`--no-service` 不代表跳过 Herdr 检查；离线拷贝使用 `--no-service --no-enroll --skip-herdr-check`。

安装后可运行 `pairfob setup` 再检查并启动 Herdr，或 `pairfob setup --install-herdr` 补齐缺少的依赖。`pairfob doctor` 只诊断，不安装、不启动。旧协议、启动失败、无效的 `HERDR_BIN` 或 socket 配置都需要修复后再继续；不会自动升级或重启已有 Herdr 会话。设置 `PAIRFOB_HERDR_AUTOSTART=0` 或多会话模式时，需要自行启动配置的 Herdr 服务。

## 脚本实际做了什么

1. 按当前系统下载对应的 `pairfob`
2. 核对校验和，对不上就失败，不会覆盖已有文件
3. 检查 Herdr，必要时经同意安装并启动，验证接口就绪
4. 完成登记
5. 除非 `--no-service`，否则装上登录即启动的**用户级**服务

## 参数

| 参数 | 作用 |
| --- | --- |
| `--prefix DIR` | 安装目录。可写的 `/usr/local/bin` 时用那里，否则 `~/.local/bin` |
| `--no-service` | 只装二进制和登记，不装登录服务 |
| `--no-enroll` | 跳过登记；不会自动跳过服务或 Herdr 检查 |
| `--install-herdr` | 缺少 Herdr 时安装固定版本，不询问 |
| `--non-interactive` | 禁止交互询问；未允许安装时缺少依赖则失败 |
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

登录一次之后，服务会自己起来。这是登录级服务，不是开机守护进程：睡眠和注销会停掉，回到同一次图形会话后再起来。当前这次图形会话如果还没装服务，可先在这个终端跑 `pairfob`，或：

```sh
pairfob service status
pairfob service restart
```

日常不需要碰这些。`pairfob update` 会换成新二进制并重启已安装的用户服务。

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

适合本机对照。仓库在 [arronKler/pairfob](https://github.com/arronKler/pairfob)。仍然需要安装 Herdr。日常使用还是上面的安装命令。

```sh
go run ./cmd/pairfob
```

本地配对和校验见仓库 README。
