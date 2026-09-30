import { useSyncExternalStore } from "react";
import { boardStore } from "../../features/board/layout-store";
import { BoardZoomControls, type BoardScreenActions } from "../../features/board/components/board-screen";
import type { BoardViewModel } from "../../features/board/model/board-view";
import { boardZoomState } from "./board-bridge";

const subscribe = (listener: () => void) => boardStore.subscribe(listener);
/** A scalar key, so a pan that keeps the percent and the fit state renders nothing. */
const snapshot = () => { const zoom = boardZoomState(); return `${zoom.atFit ? 1 : 0}|${zoom.percent}`; };

/**
 * The zoom control that follows the camera. The camera publishes at pointer
 * speed; only this small control subscribes to it, and only re-renders when the
 * shown percent or the fit state changes — the board page never does.
 */
export function BoardZoom({ view, actions }: { view: BoardViewModel; actions: Pick<BoardScreenActions, "fit" | "zoom"> }) {
  const [atFit, percent] = useSyncExternalStore(subscribe, snapshot).split("|");
  return <BoardZoomControls percent={Number(percent)} atFit={atFit === "1"} actions={actions} view={view} />;
}
