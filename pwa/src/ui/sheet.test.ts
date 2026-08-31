import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./sheet.ts", import.meta.url)).text();

describe("action sheet", () => {
  test("title ids do not need a secure-context UUID", () => {
    expect(source).not.toContain("randomUUID");
    expect(source).toContain("sheet-title-");
  });

  /**
   * The ⋯ control sits above a bottom sheet. Opening from its click used to
   * attach a backdrop dismiss immediately, so the same tap landed on the
   * dialog and closed it before anything painted.
   */
  test("a full-height sheet can be dismissed from the header", () => {
    const sheet = source.slice(source.indexOf("export function sheet("), source.indexOf("export function afterClose("));
    expect(sheet).toContain("sheet-close");
    expect(sheet).toContain('t("close")');
    expect(sheet).toContain("sheet-head");
    expect(sheet).toContain("sheet-body");
    expect(sheet).toContain("form.append(head, body)");
    expect(source).toContain("button:not(:disabled):not(.sheet-close)");
    expect(source).toContain("parts.body.append");
    expect(source).not.toContain("parts.form.append(list");
    expect(source).not.toContain("parts.form.append(item");
  });

  test("backdrop dismiss ignores the opening gesture", () => {
    const sheet = source.slice(source.indexOf("export function sheet("), source.indexOf("export function afterClose("));
    expect(sheet).toContain("OPEN_GESTURE_MS");
    expect(sheet).toContain("performance.now()");
    expect(sheet).not.toMatch(/preventDefault\(\);\s*close\(\)/);
  });

  /**
   * WebKit drops a showModal() that runs in the same turn as dialog.close().
   * Menu items that open a follow-up dialog would then look like a dead tap.
   */
  test("menu actions run only after the sheet has closed", () => {
    expect(source).toContain("export function afterClose(");
    expect(source).toContain("window.setTimeout(() => void action(), 0)");
    expect(source).not.toMatch(/parts\.close\(\);\s*await action\(\)/);
    expect(source).toContain("afterClose(parts.dialog, action)");
  });
});
