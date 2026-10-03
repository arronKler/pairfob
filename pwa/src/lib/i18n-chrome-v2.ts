/** Pane header identity and shared-transition copy. Chinese is the source; English must cover the same keys. */
export const zhChromeV2 = {
  "chrome.backWaiting": "返回列表，另有 {n} 个窗格在等你",
} as const;

export const enChromeV2: { [K in keyof typeof zhChromeV2]: string } = {
  "chrome.backWaiting": "Back to list, {n} other panes waiting on you",
};
