---
title: 电脑上的命令
description: pair、list、forget、doctor、update。装好后后台跑，敲 pairfob 看状态。
---

# 电脑上的命令

装好后 Pairfob 在后台跑。终端里直接敲 `pairfob`（后面不跟子命令）会打印一段人话状态：在不在跑、配了对几台、Herdr 开没开。

```
Pairfob is running.
1 device paired.
Herdr is on.

  pairfob pair     pair a device
  pairfob list     what's paired
  pairfob doctor   full check
```

没在跑时会提示：安装后登录会启动，或在这个终端跑 `pairfob`。睡眠和注销会停掉登录服务，回到同一次会话后再起来。

## 日常命令

```sh
pairfob pair      # 配对手机、平板或另一台电脑
pairfob list      # 已经配对的设备
pairfob forget 1  # 解除第 1 台（序号来自 list）
pairfob doctor    # 本机检查
pairfob update    # 换成最新版本并重启用户服务
pairfob version
pairfob help
```

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
| Running | yes | 登录服务没起来，看 `pairfob service status` |
| Paired | ≥ 1 | 还没配对，跑 `pairfob pair` |
| Herdr | on | `off — open Herdr on this computer` |
| Origin | `pairfob.com` | 还没登记 |

`doctor` 在 Running 或 Herdr 不正常时会以失败退出，方便脚本检测。

## 服务

安装脚本默认会装用户服务。需要手调时：

```sh
pairfob service status
pairfob service restart
pairfob service stop
pairfob service start
pairfob service uninstall
pairfob service install
```

推送相关的环境变量不会自动写进服务文件，需要的话见 [通知](/zh/push)。

## 更新

```sh
pairfob update
```

换成最新版本并重启已安装的用户服务。不要把 `install.sh` 再跑一遍当更新。

## 进阶（日常帮助里不列）

这些仍然可用，主要给自动化和排障：

| 命令 | 用途 |
| --- | --- |
| `pairfob pair new` | 只开配对、打印码，不进入交互确认 |
| `pairfob pair accept` / `deny` | 不按 Enter、用命令确认或拒绝 |
| `pairfob enroll` | 再登记一次。安装脚本已经做过 |
| `pairfob relay rekey` | 轮换重连凭据 |
| `pairfob device revoke <id>` | 按设备 id 吊销（`forget N` 更常用） |
