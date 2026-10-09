/** Desk copy. Chinese is the source; English must cover the same keys. */
export const zhDeskConnect = {
  "connect.ledeWideScan": "在要控制的那台电脑上显示二维码，用这台设备扫一下。之后就能在这里看到它上面的会话。",
  "connect.ledeTyped": "在要控制的那台电脑上生成配对码，填到下面。之后这个浏览器就能看到它上面的会话。",
  "connect.failedLedeCode": "在电脑上重新运行 pairfob pair，再输入新显示的配对码。",
  "connect.stepsAria": "配对步骤",
  "connect.step1": "在电脑终端里运行",
  "connect.step2Code": "把终端显示的配对码填到右边",
  "connect.step2CodeBelow": "把终端显示的配对码填到下面",
  "connect.step2Scan": "扫终端里出现的二维码",
  "connect.installLink": "查看安装方法",
  "connect.phoneNote": "想在手机上用：用手机打开 pairfob.com，扫终端里的二维码。",
  "connect.pairPlaceholder": "粘贴或输入配对码",
  "unreach.networkDetailDesk": "换一个 Wi-Fi 或有线网络，也可以临时连一下手机热点。",
  "unreach.deskTitle": "连不上 {target}",
} as const;

export const enDeskConnect: { [K in keyof typeof zhDeskConnect]: string } = {
  "connect.ledeWideScan": "Show a QR on the computer you want to control and scan it with this device. Its sessions then appear here.",
  "connect.ledeTyped": "Get a pairing code on the computer you want to control and type it below. This browser can then see the sessions on it.",
  "connect.failedLedeCode": "Run pairfob pair on the computer again, then type the new pairing code.",
  "connect.stepsAria": "Pairing steps",
  "connect.step1": "Run this in a terminal on the computer",
  "connect.step2Code": "Type the pairing code it shows on the right",
  "connect.step2CodeBelow": "Type the pairing code it shows in the field below",
  "connect.step2Scan": "Scan the QR the terminal shows",
  "connect.installLink": "See how to install",
  "connect.phoneNote": "For your phone: open pairfob.com on it and scan the QR in the terminal.",
  "connect.pairPlaceholder": "Paste or type the pairing code",
  "unreach.networkDetailDesk": "Try another Wi-Fi or a wired network, or tether to your phone for a moment.",
  "unreach.deskTitle": "Can't reach {target}",
};
