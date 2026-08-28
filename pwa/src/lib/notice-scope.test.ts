import { describe, expect, test } from "bun:test";
import { sameNoticeScope, type NoticeScope } from "./notice-scope";

const paneScope: NoticeScope = {
  phase: "live",
  screen: "pane",
  daemonId: "daemon-a",
  paneId: "pane-a",
};

describe("notice scope", () => {
  test("keeps an async operation notice on its original pane", () => {
    expect(sameNoticeScope(paneScope, { ...paneScope })).toBe(true);
  });

  test("does not follow navigation, pane switches, or computer switches", () => {
    expect(sameNoticeScope(paneScope, { ...paneScope, screen: "home" })).toBe(false);
    expect(sameNoticeScope(paneScope, { ...paneScope, paneId: "pane-b" })).toBe(false);
    expect(sameNoticeScope(paneScope, { ...paneScope, daemonId: "daemon-b" })).toBe(false);
    expect(sameNoticeScope(paneScope, { ...paneScope, phase: "resuming" })).toBe(false);
  });
});
