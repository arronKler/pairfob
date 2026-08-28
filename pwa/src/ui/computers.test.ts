import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./computers.ts", import.meta.url)).text();

describe("computer picker copy", () => {
  test("one stored computer is an offline retry, not a multi-machine chooser", () => {
    expect(source).toContain("连不上电脑");
    expect(source).toContain("若刚合盖，电脑可能已经睡眠");
    expect(source).toContain("确认电脑醒着且 pairfobd 在跑后再点下面重试");
    expect(source).toContain("选择电脑");
    expect(source).toContain("这台手机已经配对过多台电脑");
    expect(source).toContain("另一台电脑要先装 pairfobd");
  });

  test("forgetting a computer is local and does not say revoke", () => {
    expect(source).toContain("computer-forget");
    expect(source).toContain("从这台手机去掉");
    expect(source).not.toContain("吊销这台设备");
  });
});
