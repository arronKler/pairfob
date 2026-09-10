import { describe, expect, test } from "bun:test";
import { fullTerminalHostIsPan, sameFullTerminalView, type FullTerminalViewFields } from "./model";

const view = (patch: Partial<FullTerminalViewFields> = {}): FullTerminalViewFields => ({
  owner: "1:p1:1",
  paneId: "p1",
  title: "term",
  working: true,
  stage: "live",
  detail: "ok",
  retry: false,
  busy: false,
  composeLive: false,
  keyboardOpen: false,
  ...patch,
});

describe("full terminal view model", () => {
  test("pan mode is only the pan fit", () => {
    expect(fullTerminalHostIsPan("pan")).toBeTrue();
    expect(fullTerminalHostIsPan("fit")).toBeFalse();
  });

  test("unchanged chrome fields compare equal", () => {
    expect(sameFullTerminalView(view(), view())).toBeTrue();
    expect(sameFullTerminalView(view(), view({ detail: "next" }))).toBeFalse();
    expect(sameFullTerminalView(view(), view({ owner: "2:p2:1" }))).toBeFalse();
  });
});
