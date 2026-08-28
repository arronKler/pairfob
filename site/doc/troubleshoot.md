---
title: Troubleshooting
description: Herdr closed, sleep, a closed lid, locator missing, devices out of sync. Start with pairfobd doctor.
---

# Troubleshooting

On the computer first:

```sh
pairfobd doctor
```

Logs live at `~/.config/pairfob/pairfobd.log` (or under `PAIRFOB_STATE_DIR`). Service:

```sh
pairfobd service status
```

macOS: `launchctl print gui/$UID/com.pairfob.pairfobd`. Linux: `systemctl --user status pairfobd.service`.

## Sentences in the UI

The app copy is Chinese. Match the string on screen:

| You see | Do this first |
| --- | --- |
| 电脑现在不在线 | Sleep, a closed lid, a dropped network, or `pairfobd` not running. Wake the computer; you do not pair again. Then `pairfobd doctor` |
| 电脑上的 Herdr 现在没开 / 电脑上的 Herdr 没有运行 | The machine is up, but Herdr quit. Open Herdr; Pairfob recovers automatically |
| 还没有读到会话 | Herdr is closed; the empty-state detail says to open it |
| 还没有会话 | Connected, but there is no pane yet — create one or open a terminal on the computer |
| 请完整输入电脑上显示的配对码 | Hand entry is 8+6 glyphs |
| 配对码还没输完整：需要 14 位 | Include the locator |
| 配对码过期或已经用过 | `pairfobd pair` again on the computer |
| 配对码不正确 | Use the code being printed now; do not edit the old one |
| 尝试太频繁 | Wait; do not loop |
| 当前 Herdr 版本还不支持这个操作 | Computer capability, not a missing phone button |
| 电脑可能已经执行了操作 | Do not double-tap; look at the frame |
| 这个会话已经不在了 | Back to the list |
| 另一个窗口接管了这台手机 | Keep a single Pairfob page |
| 无法读取站点配置 / 无法连上当前站点 | Network or wrong origin / wrong page |
| 另一台电脑开启了配对 | Slot stolen; `pair` on the computer you mean |

## doctor

| Output | Action |
| --- | --- |
| Running no | `pairfobd` or `pairfobd service restart`; read the log |
| Herdr off | Automatic startup did not complete. Confirm Herdr 0.7+ is installed, run `herdr`, then inspect `~/.config/herdr/herdr-server.log` |
| Origin … not set up | Rerun the installer; do not set `PAIRFOB_JOIN_TOKEN` |
| Origin protocol does not match | This computer’s enroll does not match the origin — see “moving origin” |
| Paired 0 | `pairfobd pair` |

## Install and enroll

- Do not set `PAIRFOB_JOIN_TOKEN`
- An enrolled machine reuses `relay.json`
- SHA-256 mismatch: the script fails closed. Do not skip verification or substitute a random binary
- Unsupported OS (Windows): the script refuses
- If `~/.local/bin` is not on PATH, `pairfobd` is “not found” even when the service is installed

## Pairing

- Use the code in the **current** terminal, not a screenshot
- Hand entry is 14 glyphs; missing the locator means the request is not sent
- Scan failures: camera permission, or type instead
- The computer must still be waiting in `pairfobd pair`; Ctrl-C means open a new slot
- Two computers running `pair` at once steal the slot from each other

## Connected but cannot act

- Reads need an Established session. Still on the scan page means not paired
- If Herdr quit, an open pane fails; open Herdr first
- Missing capability buttons: [Where capabilities come from](/capabilities). Upgrade the **running** server, not another CLI on disk
- Path rejected: cwd escaped Home / `PAIRFOB_ALLOWED_ROOTS` / live roots

## Sleep, lock, lid

- Locked screen, machine still up: should work. Pairfob does not need the desktop unlocked
- Closed lid / sleep: the phone shows **电脑现在不在线**. Open the lid or wake it. Do not pair again; the computer stays on the list
- Herdr quit while the machine is awake: **电脑上的 Herdr 现在没开**
- Pairfob cannot wake a sleeping computer. Details: [FAQ](/faq)

## Still stuck

Keep the full `pairfobd doctor` output (you can redact hostnames other than Origin) and the last few dozen **non-secret** log lines. Do not paste `relay.json`, pairing codes, or VAPID private keys.
