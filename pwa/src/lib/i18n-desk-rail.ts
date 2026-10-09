/** Desk copy. Chinese is the source; English must cover the same keys. */
export const zhDeskRail = {
  "rail.search": "搜索或跳转…",
  "rail.nextAttention": "定位下一个需要你的会话，共 {count} 个",
  "rail.createMore": "新建会话",
  "rail.herdrOff": "Herdr 不可用",
  "rail.reconnecting": "正在重连",
} as const;

export const enDeskRail: { [K in keyof typeof zhDeskRail]: string } = {
  "rail.search": "Search or jump…",
  "rail.nextAttention": "Locate the next session that needs you, {count} in all",
  "rail.createMore": "New session",
  "rail.herdrOff": "Herdr unavailable",
  "rail.reconnecting": "Reconnecting",
};
