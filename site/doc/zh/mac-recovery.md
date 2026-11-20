# 在手机上唤醒或登录 Mac

如果 Mac 只是熄屏，先在 Pairfob 打开远程桌面。Mac 进入系统睡眠、锁屏或停在启动界面时，可以从电脑详情或离线页面打开「唤醒或登录电脑」。首次设置时填入你自己的 HTTPS 恢复控制台地址，每个浏览器、每台已配对电脑分别保存。已有带浏览器界面的硬件 KVM 也可以直接使用。

## 准备常开设备

恢复控制台运行在同一可信管理局域网内的另一台常开 Linux 设备上，例如带 Docker Compose 的 NAS。手机需要能通过私有网络访问它。恢复画面和登录输入经过这台设备，所以它和它的管理员都必须受信任。正常远程桌面的画面、声音和输入依然使用 Pairfob 的 P2P 连接。

1. 为 Mac 的有线网卡保留固定 IPv4 地址，记下地址、前缀长度和以太网 MAC 地址。开启「唤醒以供网络访问」。唤醒取决于 Mac 机型、电源、网卡及合盖状态。
2. 在 Mac 的「系统设置 → 通用 → 共享」开启「屏幕共享」，允许你计划使用的 Mac 账户。使用该账户认证。供普通 VNC 查看器共用的兼容密码保持关闭。
3. 在常开设备的 Pairfob 源码目录执行以下命令。替换示例网卡地址，输出目录须尚未存在。服务使用本机回环端口 18482 和 18483。请选用由你独占管理的主机，避免其他本地用户访问后台端口。

```sh
export PAIRFOB_RECOVERY_DIR="$HOME/pairfob-recovery"
python3 scripts/mac-recovery/configure.py \
  --mac-ip 192.168.1.40/24 --ethernet 02:00:00:00:00:40 \
  --output "$PAIRFOB_RECOVERY_DIR"
docker compose -f scripts/mac-recovery/compose.yaml up -d
```

4. 用已有私有 HTTPS 反向代理转发到 `http://127.0.0.1:18482`。若手机和常开设备已加入同一 Tailscale 网络，且服务端口空闲，可运行 `tailscale serve --bg http://127.0.0.1:18482`，通过访问规则只允许自己的设备。把显示的 HTTPS 地址填入 Pairfob。首次登录控制台的用户名为 `pairfob`，随机密码在输出目录的 `console-password` 文件里，建议保存在你的密码管理器中。[Tailscale 私有 HTTPS 说明](https://tailscale.com/docs/reference/tailscale-cli/serve)

## 手机操作

从「唤醒或登录电脑」打开保存的地址，登录控制台，选择 **Wake and sign in**。控制台向预设网卡发送局域网唤醒包，连接系统屏幕共享并提示输入允许的 Mac 账户凭据。如果系统显示会话选择器，选择原来在用的账户／屏幕。能否接回物理桌面取决于这台 Mac 的屏幕共享行为。恢复后返回 Pairfob，打开「远程桌面」重新直连。[Apple 屏幕共享](https://support.apple.com/guide/mac-help/mh11848/mac) · [Guacamole 唤醒和认证](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)

**重启后出现 FileVault 时**，Apple 芯片 Mac 在 macOS 26 及以上支持通过 SSH 解锁，前提是事先开启「远程登录」，并且启动阶段已经联网。为该功能单独核实启动阶段的 SSH 主机公钥，将一行 `Mac的IPv4地址 密钥类型 公钥` 保存到文件。在生成控制台配置时附加 `--known-host /path/to/verified-known-host`，即可在手机选择 **FileVault SSH**。验证主机密钥后在控制台输入获准的账户凭据；磁盘解锁可能使 SSH 连接结束。等系统启动后再选择屏幕共享完成图形登录。没有可信主机公钥时配置只生成屏幕共享入口。冷启动、无线网络和第三方网卡需要分别验收。硬件 KVM 可用于能输出启动画面并接受 USB 键盘的机型。[Apple FileVault 启动网络条件](https://support.apple.com/guide/deployment/dep82064ec40/web)

## 停用

在 PWA 选择「移除地址」即可删除本机快捷入口。要实际停止控制台访问，在常开设备运行 `docker compose -f scripts/mac-recovery/compose.yaml down`，并关闭该服务的私有 HTTPS 路由。Pairfob 取消配对和 Mac 系统账户、私网访问权限分别管理。更换控制台密码时，使用新的输出目录重新生成配置并重建服务。
