/** Session header identity and shared-transition copy. Chinese is the source; English must cover the same keys. */
export const zhChromeV2 = {
  "chrome.backWaiting": "返回列表，另有 {n} 个会话在等你",
  "chrome.ruler": "会话位置",
  "chrome.rulerValue": "{n} / {total} · {title}",
  "chrome.rulerPosition": "{n} / {total}",
  "chrome.rulerSameTab": "同一 tab",
  "chrome.rulerOtherTab": "同一工作区 · 另一个 tab",
  "chrome.rulerOtherWorkspace": "另一个工作区",
  "chrome.rulerNow": "现在",
  "chrome.rulerTarget": "目标",
} as const;

export const enChromeV2: { [K in keyof typeof zhChromeV2]: string } = {
  "chrome.backWaiting": "Back to list, {n} other sessions waiting on you",
  "chrome.ruler": "Session position",
  "chrome.rulerValue": "{n} / {total} · {title}",
  "chrome.rulerPosition": "{n} / {total}",
  "chrome.rulerSameTab": "Same tab",
  "chrome.rulerOtherTab": "Same workspace · another tab",
  "chrome.rulerOtherWorkspace": "Another workspace",
  "chrome.rulerNow": "Now",
  "chrome.rulerTarget": "Target",
};
