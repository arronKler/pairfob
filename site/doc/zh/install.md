---
title: 安装
description: install.sh 会下载 pairfobd、核对校验和、登记，并装上登录即启动的用户服务。
---

# 安装

托管安装从 `https://pairfob.com/dl` 拉二进制（可用 `PAIRFOB_DOWNLOAD_BASE` 覆盖）。需要 `curl`。支持 macOS 和 Linux，架构是 amd64 或 arm64。Windows 会直接拒绝。

```sh
curl -fsSL https://pairfob.com/install.sh | sh
```

第二台电脑也是这条命令。装好后在手机上：**设置 → 添加另一台电脑**。不要设 `PAIRFOB_JOIN_TOKEN`。

## 脚本实际做了什么

1. 识别 `uname -s` / `uname -m`，选 `pairfobd-darwin-arm64` 这类名字
2. 下载二进制和 `SHA256SUMS`，本地再算一遍哈希
3. 对不上 → 退出，不会覆盖你机器上已有的文件
4. 把二进制放到安装前缀（见下表）
5. 完成 enroll，把 reconnect 凭据写进状态目录
6. 除非 `--no-service`，否则装上登录即启动的**用户级**服务（不需要 root 守护进程）

## 参数

| 参数 | 作用 |
| --- | --- |
| `--origin URL` | 默认 `https://pairfob.com`。不要改 |
| `--prefix DIR` | 安装目录。root 或可写的 `/usr/local/bin` 时用那里，否则 `~/.local/bin` |
| `--no-service` | 只装二进制和 enroll，不装登录服务 |
| `--no-enroll` | 只装二进制。给测试和离线拷贝用 |

也可以：

```sh
curl -fsSL https://pairfob.com/install.sh | sh -s -- --prefix "$HOME/bin"
```

环境变量：

| 变量 | 作用 |
| --- | --- |
| `PAIRFOB_DOWNLOAD_BASE` | 覆盖下载根，默认 `https://pairfob.com/dl` |
| `PAIRFOB_INSTALL_PREFIX` | 等同 `--prefix` 的默认值 |

已经登记过的机器再跑一遍安装脚本会换成新二进制，并留下原来的 `relay.json`。

## 装到哪里

| 条件 | 二进制 |
| --- | --- |
| 以 root 装，或 `/usr/local/bin` 可写 | `$PREFIX/pairfobd`，默认 `/usr/local/bin/pairfobd` |
| 普通用户 | 默认 `~/.local/bin/pairfobd` |

若 `~/.local/bin` 不在 `PATH` 里，安装脚本会提醒你加进去，例如 zsh：

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## 装完之后

- 用户服务
  - macOS：`~/Library/LaunchAgents/com.pairfob.pairfobd.plist`，标签 `com.pairfob.pairfobd`
  - Linux：`~/.config/systemd/user/pairfobd.service`
- 日志：`~/.config/pairfob/pairfobd.log`（若设了 `PAIRFOB_STATE_DIR` 则在那个目录）
- 状态目录默认 `~/.config/pairfob`，权限目录 `0700`、文件 `0600`
- 里面有身份、reconnect、设备列表、可选的推送密钥。按**敏感凭据**备份，不要提交到 git

登录一次之后，服务会自己起来。这是登录级服务，不是开机守护进程：睡眠和注销会停掉，回到同一次图形会话后再起来。当前这次图形会话如果还没装服务，可先在这个终端跑 `pairfobd`，或：

```sh
pairfobd service status
pairfobd service restart
```

日常不需要碰这些。`pairfobd update` 会换成新二进制并重启已安装的用户服务。

## 更新

```sh
pairfobd update
```

它从当前 origin 的 `/dl` 拉产物，核对校验和，替换正在用的那份二进制，并重启用户服务。不要把安装脚本再跑一遍当「更新」。

## 卸载

```sh
pairfobd service uninstall
rm -f "$(command -v pairfobd)"
```

只卸服务不会删状态目录。若要连配对关系一起忘掉，再删 `~/.config/pairfob`（先确认你不再需要那些设备凭证）。

## 已经登记过的机器

enroll 成功后会留下 `relay.json`。以后启动复用它。

## 从源码跑

适合改协议或本机对照。仍然需要安装 Herdr；`pairfobd` 启动时会拉起默认单会话 server。

```sh
go run ./cmd/pairfobd
```

`PAIRFOB_ORIGIN` 缺省就是 `https://pairfob.com`。不要同时设 `PAIRFOB_JOIN_TOKEN`。

## 兼容

`--grant jg_…` 和 `PAIRFOB_JOIN_GRANT` 仍能对着已有 grant 登记。产品路径不用它们。
