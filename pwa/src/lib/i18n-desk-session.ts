/** Desk copy. Chinese is the source; English must cover the same keys. */
export const zhDeskSession = {
  "deskChrome.notConnected": "未连接",
  "deskDock.keys": "按键",
  "deskDock.keysShow": "显示按键",
  "deskDock.keysHide": "收起按键",
  "deskDock.hintBatch": "组字：写完再发，Enter 发送",
  "deskDock.hintLive": "实时：每个键都发到会话，F6 移出",
  "deskDock.liveFieldAria": "把键盘交给终端",
  "deskDock.hintChat": "Enter 发送 · Shift+Enter 换行",
  "deskDock.batchPh": "组字 · 写完再发送",
  "deskDock.batchKeysPh": "组字 · Enter 发送",
  "deskDock.liveKeysPh": "实时 · 按 F6 移出，其余每个键都发到会话",
  "deskSet.enterKeySends": "屏幕键盘回车发送",
  "deskSet.enterOn": "屏幕键盘上回车直接发送；实体键盘始终是 Enter 发送、Shift+Enter 换行。",
  "deskSet.enterOff": "屏幕键盘上回车换行，用发送键发送；实体键盘始终是 Enter 发送、Shift+Enter 换行。",
} as const;

export const enDeskSession: { [K in keyof typeof zhDeskSession]: string } = {
  "deskChrome.notConnected": "not connected",
  "deskDock.keys": "Keys",
  "deskDock.keysShow": "Show keys",
  "deskDock.keysHide": "Hide keys",
  "deskDock.hintBatch": "Compose: write it, then Enter sends",
  "deskDock.hintLive": "Live: every key goes to the session, F6 leaves it",
  "deskDock.liveFieldAria": "Give the keyboard to the terminal",
  "deskDock.hintChat": "Enter sends · Shift+Enter adds a line",
  "deskDock.batchPh": "Compose · Send",
  "deskDock.batchKeysPh": "Compose · Enter sends",
  "deskDock.liveKeysPh": "Live · F6 leaves; every other key is sent",
  "deskSet.enterKeySends": "On-screen Return sends",
  "deskSet.enterOn": "On the on-screen keyboard Return sends; a hardware keyboard always sends with Enter, and Shift+Enter adds a line.",
  "deskSet.enterOff": "On the on-screen keyboard Return adds a line and the send button sends; a hardware keyboard always sends with Enter, and Shift+Enter adds a line.",
};
