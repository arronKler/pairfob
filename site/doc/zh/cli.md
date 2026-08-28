---
title: 电脑上的命令
description: pair、list、forget、doctor、update。装好后后台跑，敲 pairfobd 看状态。
---

# 电脑上的命令

装好后 Pairfob 在后台跑。终端里直接敲 `pairfobd`（后面不跟子命令）会打印一段人话状态：在不在跑、配了对几台、Herdr 开没开。

```
Pairfob is running.
1 device paired.
Herdr is on.

  pairfobd pair     pair a device
  pairfobd list     what's paired
  pairfobd doctor   full check
```

没在跑时会提示：安装后登录会启动，或在这个终端跑 `pairfobd`。睡眠和注销会停掉登录服务，回到同一次会话后再起来。

## 日常命令

```sh
pairfobd pair      # 配对手机、平板或另一台电脑
pairfobd list      # 已经配对的设备
pairfobd forget 1  # 解除第 1 台（序号来自 list）
pairfobd doctor    # 本机检查
pairfobd update    # 换成最新版本并重启用户服务
pairfobd version
pairfobd help
```

`pair`、`list`、`forget` 通过 `$PAIRFOB_STATE_DIR/pairfobd.sock`（权限 `0600`）和正在跑的进程说话。socket 只接受同一用户。没有本机 HTTP 管理面。

`forget` 也可以写设备名；重名时必须用序号。`unpair` 是 `forget` 的别名。

## doctor

```
Pairfob <version>

  Running     yes
  Paired      1
  Herdr       on
  Origin      pairfob.com
```

| 项 | 正常 | 不正常时 |
| --- | --- | --- |
| Running | yes | 登录服务没起来，看 `~/.config/pairfob/pairfobd.log`，或 `pairfobd service status` |
| Paired | ≥ 1 | 还没配对，跑 `pairfobd pair` |
| Herdr | on | `off — open Herdr on this computer` |
| Origin | `pairfob.com` | 没登记、或和这台电脑协议对不上 |

`doctor` 在 Running 或 Herdr 不正常时会以失败退出，方便脚本检测。

## 服务

安装脚本默认会装用户服务。需要手调时：

```sh
pairfobd service status
pairfobd service restart
pairfobd service stop
pairfobd service start
pairfobd service uninstall
pairfobd service install
```

- macOS：LaunchAgent `com.pairfob.pairfobd`
- Linux：systemd --user `pairfobd.service`

推送相关的环境变量不会自动写进服务文件，需要的话见 [通知](/zh/push)。

## 更新

```sh
pairfobd update
```

从当前 origin 的 `/dl` 拉二进制，核对 SHA-256，替换自身，并重启已安装的用户服务。不要把 `install.sh` 再跑一遍当更新。

## 进阶（日常帮助里不列）

这些仍然可用，主要给自动化和排障：

| 命令 | 用途 |
| --- | --- |
| `pairfobd pair new` | 只开槽、打印码，不进入交互确认 |
| `pairfobd pair status` | 当前槽的 JSON |
| `pairfobd pair accept` / `deny` | 不按 Enter、用命令确认或拒绝 |
| `pairfobd enroll` | 再登记一次。安装脚本已经做过 |
| `pairfobd relay rekey` | 轮换 reconnect 凭据 |
| `pairfobd device revoke <id>` | 按设备 id 吊销（`forget N` 更常用） |

`PAIRFOB_PAIR_CODE` 会在进程启动时自动开一个配对槽，只留给自动化。不要在日常登录环境里设它。
`PAIRFOB_DEV_AUTO_ADMIT=1` 会跳过电脑上的确认，**只允许用在隔离的自动测试里**。
