/** Desk copy. Chinese is the source; English must cover the same keys. */
export const zhDeskInspector = {
  "inspector.label": "文件与更改",
  "inspector.close": "关闭文件与更改",
  "inspector.expand": "整页打开",
  "inspector.backToList": "{name}，返回列表",
  "diffNotes.setAside": "先放一边，留作未保存的批注",
} as const;

export const enDeskInspector: { [K in keyof typeof zhDeskInspector]: string } = {
  "inspector.label": "Files and changes",
  "inspector.close": "Close files and changes",
  "inspector.expand": "Open as a full page",
  "inspector.backToList": "{name}, back to the list",
  "diffNotes.setAside": "Set aside as an unsaved note",
};
