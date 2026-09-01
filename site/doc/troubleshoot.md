---
title: Troubleshooting
description: Herdr closed, sleep, a closed lid, locator missing, devices out of sync. Start with pairfob doctor.
---

# Troubleshooting

On the computer first:

```sh
pairfob doctor
```

Service:

```sh
pairfob service status
```

## Sentences in the UI

The app copy is Chinese. Match the string on screen:

| You see | Do this first |
| --- | --- |
| 电脑现在不在线 | Sleep, a closed lid, a dropped network, or `pairfob` not running. Wake the computer; you do not pair again. Then `pairfob doctor` |
| 电脑上的 Herdr 现在没开 / 电脑上的 Herdr 没有运行 | The machine is up, but Herdr quit. Open Herdr; Pairfob recovers automatically |
| 还没有读到会话 | Herdr is closed; the empty-state detail says to open it |
| 还没有会话 | Connected, but there is no session yet — create one or open a terminal on the computer |
| 请完整输入电脑上显示的配对码 | Hand entry is 8+6 glyphs |
| 配对码还没输完整：需要 14 位 | Include the locator |
| 配对码过期或已经用过 | `pairfob pair` again on the computer |
| 配对码不正确 | Use the code being printed now; do not edit the old one |
| 尝试太频繁 | Wait; do not loop |
| 当前 Herdr 版本还不支持这个操作 | Computer Herdr, not a missing phone button |
| 电脑可能已经执行了操作 | Do not double-tap; look at the frame |
| 这个会话已经不在了 | Back to the list |
| 另一个窗口接管了这台手机 | Keep a single Pairfob page |
| 无法读取站点配置 / 无法连上当前站点 | Network or wrong page |
| 另一台电脑开启了配对 | Slot stolen; `pair` on the computer you mean |
| 暂时无法建立 P2P，已继续使用 Relay | Direct path failed; the session stayed on Relay. To stop retries, set 网络连接方式 to **Relay** |
| 当前站点未开放 P2P | This site has direct paths off; only Relay is available |

## doctor

| Output | Action |
| --- | --- |
| Running no | `pairfob` or `pairfob service restart` |
| Herdr off | Automatic startup did not complete. Confirm Herdr 0.7+ is installed, run `herdr` |
| Origin … not set up | Rerun the installer |
| Paired 0 | `pairfob pair` |

## Install and enroll

- Do not set `PAIRFOB_JOIN_TOKEN`
- Checksum mismatch: the script fails closed
- Unsupported OS (Windows): the script refuses
- If `~/.local/bin` is not on PATH, `pairfob` is “not found” even when the service is installed
- If the installer says setup is closed: new computers cannot enroll right now. Computers already set up keep working

## Pairing

- Use the code in the **current** terminal, not a screenshot
- Hand entry is 14 glyphs; missing the locator means the request is not sent
- Scan failures: camera permission, or type instead
- The computer must still be waiting in `pairfob pair`; Ctrl-C means open a new slot
- Two computers running `pair` at once steal the slot from each other

## Network path

- Default **自动**: Relay first, then P2P when a direct path exists; a failed upgrade does not drop the session
- Direct path keeps failing: 设置 → 网络连接方式 → **Relay**
- To try a direct path again: **自动**, or **P2P** for one immediate attempt
- **Relay** pauses automatic P2P retries in this browser

## Connected but cannot act

- Still on the scan page means not paired
- If Herdr quit, an open session fails; open Herdr first
- Missing buttons: upgrade and restart the **running** Herdr
- Path rejected: outside the directories the computer allows

## Sleep, lock, lid

- Locked screen, machine still up: should work. Pairfob does not need the desktop unlocked
- Closed lid / sleep: the phone shows **电脑现在不在线**. Open the lid or wake it. Do not pair again; the computer stays on the list
- Herdr quit while the machine is awake: **电脑上的 Herdr 现在没开**
- Pairfob cannot wake a sleeping computer. Details: [FAQ](/faq)

## Still stuck

Keep the full `pairfob doctor` output. Do not paste pairing codes.
