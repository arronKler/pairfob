/** Floating row actions over the terminal. Chinese is the source; English must cover the same keys. */
export const zhRowbarV2 = {
  "rowbar.aria": "这一行的操作",
  "rowbar.copy": "复制",
  "rowbar.copied": "已复制",
  "rowbar.copyAria": "复制这一行",
  "rowbar.copyPath": "复制路径",
  "rowbar.copyPathAria": "复制路径 {path}",
  "rowbar.quote": "引用",
  "rowbar.quoteAria": "引用这一行到输入框",
  "rowbar.select": "选择",
  "rowbar.selectAria": "选择这一行的文字",
  "rowbar.selecting": "选择中",
  "rowbar.selectingHint": "拖动选区两端，用系统菜单复制",
  "rowbar.done": "完成",
} as const;

export const enRowbarV2: { [K in keyof typeof zhRowbarV2]: string } = {
  "rowbar.aria": "Actions for this line",
  "rowbar.copy": "Copy",
  "rowbar.copied": "Copied",
  "rowbar.copyAria": "Copy this line",
  "rowbar.copyPath": "Copy path",
  "rowbar.copyPathAria": "Copy path {path}",
  "rowbar.quote": "Quote",
  "rowbar.quoteAria": "Quote this line into the message field",
  "rowbar.select": "Select",
  "rowbar.selectAria": "Select text on this line",
  "rowbar.selecting": "Selecting",
  "rowbar.selectingHint": "Drag the handles, then copy from the system menu",
  "rowbar.done": "Done",
};
