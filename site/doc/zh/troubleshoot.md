---
title: 排查
description: Herdr 没开、睡眠、合盖、手输缺定位码、设备对不上。先 pairfobd doctor。
---

# 排查

电脑上先跑：

```sh
pairfobd doctor
```

日志在 `~/.config/pairfob/pairfobd.log`（若改过 `PAIRFOB_STATE_DIR` 则以那个目录为准）。用户服务状态：

```sh
pairfobd service status
```

macOS 还可以 `launchctl print gui/$UID/com.pairfob.pairfobd`。Linux：`systemctl --user status pairfobd.service`。

## 界面上的句子

| 你看到的 | 先做什么 |
| --- | --- |
| 电脑现在不在线 | 睡眠、合盖、断网，或 `pairfobd` 没在跑。先把电脑唤醒，不用重新配对。再 `pairfobd doctor` |
| 电脑上的 Herdr 现在没开 / 电脑上的 Herdr 没有运行 | 机器还醒着，但 Herdr 退了。打开 Herdr；Pairfob 会自动恢复 |
| 还没有读到会话 | Herdr 没开；空状态会说明打开后会自动恢复 |
| 还没有会话 | 已经连上，但还没有 pane——可以新建，或在电脑上打开终端 |
| 请完整输入电脑上显示的配对码 | 手输要 8+6 位 |
| 配对码还没输完整：需要 14 位 | 把定位码也贴上 |
| 配对码过期或已经用过 | 电脑重新 `pairfobd pair` |
| 配对码不正确 | 用当前打印的新码，不要改旧码 |
| 尝试太频繁 | 等一会儿，不要循环重试 |
| 当前 Herdr 版本还不支持这个操作 | 那是电脑上的 Herdr 能力，不是手机缺按钮 |
| 电脑可能已经执行了操作。请先刷新确认，不要立即重试 | 不要连点；先看画面 |
| 这个会话已经不在了 | 回列表 |
| 另一个窗口接管了这台手机 | 只用一个打开的 Pairfob 页 |
| 无法读取站点配置 | 网络或 origin 不对，或打开了错误的网页 |
| 另一台电脑开启了配对 | 槽被挤掉，在目标电脑上重新 `pair` |

## doctor 对照

| 输出 | 处理 |
| --- | --- |
| Running no | `pairfobd` 或 `pairfobd service restart`；看日志 |
| Herdr off | 自动启动没有成功；确认已安装 Herdr 0.7+，在这台电脑运行 `herdr`，再看 `~/.config/herdr/herdr-server.log` |
| Origin … not set up | 再跑一遍安装脚本；不要设 `PAIRFOB_JOIN_TOKEN` |
| Origin protocol does not match | 这台电脑登记的协议和 origin 不一致，见下文「迁 origin」 |
| Paired 0 | `pairfobd pair` |

## 安装和登记

- 不要设 `PAIRFOB_JOIN_TOKEN`
- 已经 enroll 的机器复用 `relay.json`
- SHA-256 对不上时安装脚本会直接失败，不要跳过校验、不要改用「随便下的二进制」
- 不支持的 OS（Windows）脚本会拒绝
- `~/.local/bin` 不在 PATH 时，敲 `pairfobd` 会找不到命令，并不是服务没装上

## 配对

- 用**当前**终端里的码，不用截图
- 手输 14 位；缺 6 位定位码时请求不会发出
- 扫码失败时检查摄像头权限，或改用手输
- 电脑必须保持 `pairfobd pair` 还在等待；Ctrl-C 掉了就重新开
- 两台电脑同时 `pair` 会互挤

## 连上了但不能操作

- 读需要 Established 会话。停在扫码页就还没配上
- 电脑 Herdr 退出后，已打开的 pane 会失败，先把 Herdr 打开
- 能力按钮缺失：看 [能力从哪来](/zh/capabilities)，升级的是正在跑的服务不是磁盘上的另一个 CLI
- 路径被拒绝：cwd 逃出了 Home / `PAIRFOB_ALLOWED_ROOTS` / live root

## 锁屏、合盖、睡眠

- 锁屏但机器还醒着：应该能用。Pairfob 不需要桌面保持解锁
- 合盖 / 睡眠：手机显示 **电脑现在不在线**。揭盖或唤醒即可，不用重新配对；电脑仍在名单上
- 机器醒着但 Herdr 退了：**电脑上的 Herdr 现在没开**
- Pairfob 唤不醒已经睡着的电脑。详见 [常见问题](/zh/faq)

## 还是不行

把 `pairfobd doctor` 的全文（可打码 Origin 以外的主机名）和日志里**不含密钥**的最后几十行留下来。不要把 `relay.json`、配对码、vapid 私钥贴出去。
