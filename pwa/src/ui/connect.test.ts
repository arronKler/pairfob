import { describe, expect, test } from "bun:test";
import { resolveHandPairing } from "../lib/pairing-input.ts";

const connectSource = await Bun.file(new URL("./connect.ts", import.meta.url)).text();
const stateSource = await Bun.file(new URL("../state.ts", import.meta.url)).text();

describe("connect locator_required local", () => {
  test("protocol 2 incomplete entry stays on the single code field", () => {
    const result = resolveHandPairing(2, "7K3M9H2P", false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toBe("locator_required");
    expect(result.field).toBe("code");
  });

  test("protocol 1 hand entry is not a connect path", () => {
    expect(connectSource).not.toContain("例如 7K3M-9H2P\"");
    expect(connectSource).toContain("例如 7K3M-9H2P-WJ3K9M");
  });

  test("adding another computer keeps the scan-first pairing surface", () => {
    expect(connectSource).toContain("添加另一台电脑");
    expect(connectSource).toContain("先在那台电脑装好 pairfob");
    expect(connectSource).toContain("cancelAddComputer");
    expect(connectSource).toContain('adding ? "page settings-page" : `prelude${busy ? " pairing" : ""}`');
    expect(connectSource).not.toContain("adding && !busy");
  });

  test("QR is primary and manual entry is an accessible disclosure", () => {
    expect(connectSource).toContain('node("details", "manual-pair")');
    expect(connectSource).toContain('node("summary", "manual-pair-summary", "无法扫码？输入配对码")');
    expect(connectSource).not.toContain("▣");
    expect(connectSource).toContain('label: "配对码"');
    expect(connectSource).not.toContain("pair-divider");
    expect(connectSource).not.toContain('label: protocol2 ? "完整配对码"');
    expect(stateSource).toContain("pairManualOpen: false");
  });

  test("waiting copy asks for Enter on the computer and does not mention SAS", () => {
    expect(connectSource).toContain("请在电脑上按 Enter，随后会自动连接。");
    expect(connectSource).toContain("等待电脑确认");
    expect(connectSource).not.toMatch(/SAS|安全词|两个短词|两个词/);
  });

  test("pairing trust copy explains the server without relay jargon", () => {
    expect(connectSource).toContain("Pairfob 服务器也看不到会话内容");
    expect(connectSource).not.toContain("relay 服务器");
  });

  test("wide screens warn that pairing opens on the other device", () => {
    expect(connectSource).toContain("isDesk() && !adding && !scanned && !busy");
    expect(connectSource).toContain("这个页面是给手机或另一台设备用的");
    expect(connectSource).toContain("跑 Herdr 的电脑请执行 pairfob pair");
  });
});
