/** Desk copy. Chinese is the source; English must cover the same keys. */
export const zhDeskOverlay = {
  "desk.gotIt": "知道了",
} as const;

export const enDeskOverlay: { [K in keyof typeof zhDeskOverlay]: string } = {
  "desk.gotIt": "Got it",
};
