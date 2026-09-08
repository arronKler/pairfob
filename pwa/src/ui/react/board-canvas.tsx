import { useEffect, useLayoutEffect, useRef } from "react";
import { agentTitle, statusLabel } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import {
  layoutForTab,
  numberDuplicateTitles,
  paneBoxes,
  type PaneBox,
  type TabLayout,
} from "../../lib/layout";
import { state } from "../../state";
import {
  applyBoardTransform,
  bindBoardCanvasGestures,
  boardStageSize,
  openBoardPane,
  zoomBoardAt,
} from "../board-canvas";
import { morphingPane, queuedKind, shareOpening } from "../transition";
import { Button, EmptyState } from "./chrome";
import { BoardAnsiPreview } from "./board-preview";

function tileClass(box: PaneBox, selected: boolean, status: string): string {
  return `board-pane status-${status}${selected ? " sel" : ""}${box.focused ? " focused" : ""}`;
}

function BoardPaneTile({
  box,
  layout,
  title,
  viewportRef,
  stageRef,
  previewPaint,
}: {
  box: PaneBox;
  layout: TabLayout;
  title: string;
  viewportRef: { current: HTMLElement | null };
  stageRef: { current: HTMLElement | null };
  previewPaint: object;
}) {
  const tileRef = useRef<HTMLButtonElement>(null);
  const agent = state.agents.find((item) => item.paneId === box.paneId);
  const status = agent?.status || "idle";
  const selected = box.paneId === state.paneId;
  const pane = layout.panes.find((item) => item.paneId === box.paneId);
  const cols = Math.round(pane?.rect.width || 0);
  const rows = Math.round(pane?.rect.height || 0);
  const zoomed = layout.zoomed && (box.focused || box.paneId === layout.focusedPaneId);
  const label = agent ? statusLabel(agent.status) : "";
  useLayoutEffect(() => {
    if (queuedKind() === "expand" && morphingPane() === box.paneId) shareOpening(tileRef.current);
  });
  return (
    <Button
      ref={tileRef}
      className={tileClass(box, selected, status)}
      data-pane-id={box.paneId}
      data-react-board-preview=""
      aria-label={t("board.paneAria", { title })}
      style={{
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        minWidth: `${box.width}px`,
        minHeight: `${box.height}px`,
      }}
      onClick={(event) => {
        event.preventDefault();
        openBoardPane(box.paneId, tileRef.current || undefined);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        const viewport = viewportRef.current;
        const stage = stageRef.current;
        if (!viewport || !stage || !tileRef.current) return;
        const frame = viewport.getBoundingClientRect();
        const spot = tileRef.current.getBoundingClientRect();
        const fill = Math.min(frame.width / Math.max(1, box.width), frame.height / Math.max(1, box.height));
        zoomBoardAt(viewport, stage, spot.left + spot.width / 2, spot.top + spot.height / 2, fill);
      }}
    >
      <span className="board-pane-head">
        <span className={`agent-dot agent-${status}`} />
        <span className="board-pane-name">{title}</span>
        {label ? <span className={`pill pill-${status}`}>{label}</span> : null}
        {zoomed ? <span className="board-pane-zoom">{t("board.zoomed")}</span> : null}
      </span>
      <BoardAnsiPreview paneId={box.paneId} cols={cols} rows={rows} paint={previewPaint} />
    </Button>
  );
}

export function BoardCanvas() {
  const previewPaint = {};
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layout = layoutForTab(state.boardTabId, state.layouts, state.agents);
  const layoutKey = JSON.stringify(layout);
  const size = layout ? boardStageSize(layout) : null;
  const boxes = layout ? paneBoxes(layout) : [];
  const titles = numberDuplicateTitles(
    boxes.map((box) => {
      const agent = state.agents.find((item) => item.paneId === box.paneId);
      return {
        id: box.paneId,
        title: agent ? agentTitle(agent, "flat") : box.paneId,
        cwd: agent?.cwd || "",
      };
    }),
  );
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage) applyBoardTransform(stage);
  });
  useEffect(() => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    const current = layoutForTab(state.boardTabId, state.layouts, state.agents);
    if (!viewport || !stage || !current) return;
    return bindBoardCanvasGestures(viewport, stage, current);
  }, [state.boardTabId, layoutKey]);
  return (
    <div ref={viewportRef} className="board-canvas" role="application" aria-label={t("board.canvasAria")}>
      {!layout ? (
        <EmptyState spec={{ figure: "grid", title: t("board.emptyTitle"), sub: t("board.empty") }} />
      ) : (
        <div ref={stageRef} className="board-stage" style={{ width: `${size!.width}px`, height: `${size!.height}px` }}>
          {boxes.map((box) => (
            <BoardPaneTile
              key={box.paneId}
              box={box}
              layout={layout}
              title={titles[box.paneId] || box.paneId}
              viewportRef={viewportRef}
              stageRef={stageRef}
              previewPaint={previewPaint}
            />
          ))}
        </div>
      )}
    </div>
  );
}
