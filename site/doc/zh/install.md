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

## 脚本实际做了什么

1. 按当前系统下载对应的 `pairfob`
2. 核对校验和，对不上就失败，不会覆盖已有文件
3. 完成登记
4. 除非 `--no-service`，否则装上登录即启动的**用户级**服务

## 参数

| 参数 | 作用 |
| --- | --- |
| `--prefix DIR` | 安装目录。可写的 `/usr/local/bin` 时用那里，否则 `~/.local/bin` |
| `--no-service` | 只装二进制和登记，不装登录服务 |
| `--no-enroll` | 只装二进制。给测试和离线拷贝用 |

也可以：

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --prefix "$HOME/bin"
```

已经登记过的机器再跑一遍安装脚本会换成新二进制，并留下原来的配对关系。

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

适合本机对照。仍然需要安装 Herdr。

```sh
go run ./cmd/pairfob
```
