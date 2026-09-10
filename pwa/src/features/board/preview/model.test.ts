import { describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import {
  ansiPreviewModel,
  BOARD_PREVIEW_MAX_PANES,
  boardPreviewPaneIds,
  previewFillScale,
  previewGridPx,
  previewLineCount,
} from "./model";

function layout(panes: Array<{ paneId: string; focused: boolean }>, focusedPaneId: string): TabLayout {
  return {
    workspaceId: "w1",
    tabId: "w1:t1",
    zoomed: false,
    focusedPaneId,
    area: { x: 0, y: 0, width: 10, height: 10 },
    panes: panes.map((pane) => ({ ...pane, rect: { x: 0, y: 0, width: 1, height: 10 } })),
  };
}

describe("board preview projection", () => {
  test("fits the TUI grid into the cell without stretching either axis", () => {
    expect(previewFillScale(480, 640, 520, 660)).toEqual({ x: 660 / 640, y: 660 / 640 });
    expect(previewFillScale(8, 16, 400, 640)).toEqual({ x: 1, y: 1 });
    expect(previewGridPx(52, 40)).toEqual({ width: 416, height: 640 });
  });

  test("line count follows the pane viewport and the id cap stays at eight", () => {
    expect(previewLineCount(48, 20)).toBe(48);
    expect(previewLineCount(undefined, 12)).toBe(12);
    expect(previewLineCount()).toBe(24);
    const ids = boardPreviewPaneIds(
      layout(
        Array.from({ length: 12 }, (_, index) => ({ paneId: `p${index + 1}`, focused: index === 8 })),
        "p9",
      ),
    );
    expect(ids).toHaveLength(BOARD_PREVIEW_MAX_PANES);
    expect(ids[0]).toBe("p9");
    expect(ids).not.toContain("p12");
  });

  test("the focused pane is read first and a null layout reads nothing", () => {
    expect(boardPreviewPaneIds(layout([{ paneId: "w1:p1", focused: false }, { paneId: "w1:p2", focused: true }], "w1:p2"))[0])
      .toBe("w1:p2");
    expect(boardPreviewPaneIds(null)).toEqual([]);
  });

  test("a short dump is padded to the layout grid, an empty one paints a single blank line", () => {
    expect(ansiPreviewModel("ok", 50, 24)).toMatchObject({ width: 400, height: 384 });
    expect(ansiPreviewModel("ok", 50, 24).lines).toHaveLength(24);
    expect(ansiPreviewModel("", 0, 0).lines).toHaveLength(1);
    expect(ansiPreviewModel("", 0, 0)).toMatchObject({ width: 0, height: 0 });
  });
});
