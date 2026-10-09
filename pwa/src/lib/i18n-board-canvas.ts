/**
 * Board canvas copy: dividers, placement, lift-to-swap and content levels.
 * Chinese is the source; English must cover the same keys.
 */
export const zhBoardCanvas = {
  "boardCanvas.dividerWidth": "拖动调整左右宽度",
  "boardCanvas.dividerHeight": "拖动调整上下高度",
  "boardCanvas.zoomedBanner": "电脑上只显示这一格",
  "boardCanvas.dragCols": "{first} 列 │ {second} 列 · {share}%",
  "boardCanvas.dragRows": "{first} 行 ─ {second} 行 · {share}%",
  "boardCanvas.placeSplit": "新的一格放在哪",
  "boardCanvas.placeSwap": "点相邻的格子交换",
  "boardCanvas.placeCancel": "取消",
  "boardCanvas.placeRight": "放在右边",
  "boardCanvas.placeDown": "放在下边",
  "boardCanvas.placeNarrow": "这一格太窄，不能再向右分",
  "boardCanvas.placeShort": "这一格太矮，不能再向下分",
  "boardCanvas.placeTooSmall": "这一格太小，不能再分屏",
  "boardCanvas.placeNoNeighbor": "这一格没有相邻的格子可以交换",
  "boardCanvas.liftLeft": "← 交换",
  "boardCanvas.liftRight": "→ 交换",
  "boardCanvas.liftUp": "↑ 交换",
  "boardCanvas.liftDown": "↓ 交换",
  "boardCanvas.liftHeld": "拖到相邻的格子交换，松手打开菜单",
  "boardCanvas.liftMoved": "放到相邻的格子上交换，放在别处取消",
  "boardCanvas.keyNoDivider": "这个方向没有分隔线可调",
  "boardCanvas.keyLimit": "到头了：每条分隔线限制在 10%–90%",
};

export const enBoardCanvas: Record<keyof typeof zhBoardCanvas, string> = {
  "boardCanvas.dividerWidth": "Drag to resize left and right",
  "boardCanvas.dividerHeight": "Drag to resize top and bottom",
  "boardCanvas.zoomedBanner": "Only this pane shows on the computer",
  // The unit leads and is said once: either side may be a single column or row.
  "boardCanvas.dragCols": "Cols {first} │ {second} · {share}%",
  "boardCanvas.dragRows": "Rows {first} ─ {second} · {share}%",
  "boardCanvas.placeSplit": "Where should the new pane go?",
  "boardCanvas.placeSwap": "Pick a neighbouring pane to swap",
  "boardCanvas.placeCancel": "Cancel",
  "boardCanvas.placeRight": "Put it on the right",
  "boardCanvas.placeDown": "Put it below",
  "boardCanvas.placeNarrow": "Too narrow to split to the right",
  "boardCanvas.placeShort": "Too short to split below",
  "boardCanvas.placeTooSmall": "This pane is too small to split",
  "boardCanvas.placeNoNeighbor": "No neighbouring pane to swap with",
  "boardCanvas.liftLeft": "← Swap",
  "boardCanvas.liftRight": "→ Swap",
  "boardCanvas.liftUp": "↑ Swap",
  "boardCanvas.liftDown": "↓ Swap",
  "boardCanvas.liftHeld": "Drag onto a neighbour to swap, or let go for the menu",
  "boardCanvas.liftMoved": "Drop on a neighbour to swap, anywhere else to cancel",
  "boardCanvas.keyNoDivider": "No divider to move in this direction",
  "boardCanvas.keyLimit": "At the limit: each divider stays between 10% and 90%",
};
