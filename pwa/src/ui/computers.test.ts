import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./computers.ts", import.meta.url)).text();

describe("computer picker copy", () => {
  test("one stored computer is an offline retry, not a multi-machine chooser", () => {
    expect(source).toContain('t("computers.offlineTitle")');
    expect(source).toContain('t("computers.offlineLede")');
    expect(source).toContain('t("computers.pick")');
    expect(source).toContain('t("computers.multiLede")');
    expect(source).toContain('t("computers.addHint")');
  });

  test("forgetting a computer is local and does not say revoke", () => {
    expect(source).toContain("computer-forget");
    expect(source).toContain('t("computers.forgetAria"');
    expect(source).not.toContain("吊销这台设备");
  });
});
