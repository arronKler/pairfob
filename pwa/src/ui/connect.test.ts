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
    expect(connectSource).toContain('t("connect.pairHint")');
  });

  test("adding another computer keeps the scan-first pairing surface", () => {
    expect(connectSource).toContain('t("settings.addComputer")');
    expect(connectSource).toContain('t("connect.ledeAdd")');
    expect(connectSource).toContain("cancelAddComputer");
    expect(connectSource).toContain('adding ? "page settings-page" : `prelude${busy ? " pairing" : ""}`');
    expect(connectSource).not.toContain("adding && !busy");
  });

  test("QR is primary and manual entry is an accessible disclosure", () => {
    expect(connectSource).toContain('node("details", "manual-pair")');
    expect(connectSource).toContain('t("connect.manualSummary")');
    expect(connectSource).not.toContain("▣");
    expect(connectSource).toContain('t("connect.pairCode")');
    expect(connectSource).not.toContain("pair-divider");
    expect(connectSource).not.toContain('label: protocol2 ? "完整配对码"');
    expect(stateSource).toContain("pairManualOpen: false");
  });

  test("waiting copy asks for Enter on the computer and does not mention SAS", () => {
    expect(connectSource).toContain('t("connect.waitEnterCopy")');
    expect(connectSource).toContain('t("connect.waitEnter")');
    expect(connectSource).not.toMatch(/SAS|安全词|两个短词|两个词/);
  });

  test("pairing trust copy explains the server without relay jargon", () => {
    expect(connectSource).toContain('t("connect.trust")');
    expect(connectSource).not.toContain("relay 服务器");
  });

  test("wide screens warn that pairing opens on the other device", () => {
    expect(connectSource).toContain("isDesk() && !adding && !scanned && !busy");
    expect(connectSource).toContain('t("connect.deskHint")');
  });

  test("the pairing surface includes a compact language select", () => {
    expect(connectSource).toContain("languageSelect()");
    expect(connectSource).toContain("connect-lang");
    expect(connectSource).not.toContain("languageControl()");
  });
});
