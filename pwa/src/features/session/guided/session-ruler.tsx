/**
 * The session ruler: the herd list's rows drawn as ticks on the header's bottom
 * border, in the order the reader last saw the list. Tapping or dragging a tick
 * previews the session under the header and commits it on release; arrows step
 * one and Home/End jump, on the focused slider. It costs no header height and
 * never moves the content under it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../lib/i18n";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { ListGroup } from "../../../lib/ranking";
import { isDesk } from "../../../app/viewport";
import { prefersReducedMotion } from "../../../shared/ui/dom/motion";
import { AgentAvatar } from "../../../shared/ui/primitives";
import { usePreferences } from "../../settings/hooks";
import { useBoard } from "../../board/hooks";
import { panePosition } from "../../board/model/pane-menu";
import { heldShownListOrder } from "../../dashboard/list-order";
import { peekPlacement, rulerMapBoxes, rulerRelation, rulerView, type PeekPlacement } from "./session-ruler-model";
import { switchSessionInPlace } from "./session-ruler-action";

export type SessionRulerProps = {
  paneId: string;
  agents: readonly DashboardAgentCard[];
  listGroup: ListGroup;
  stale: boolean;
};

type Preview = { phase: "idle" } | { phase: "drag" | "demo"; index: number };

const IDLE: Preview = { phase: "idle" };
const DEMO_SEEN_KEY = "pairfob:rulerDemo";
const DEMO_DELAY_MS = 650;
const DEMO_HOLD_MS = 1400;

let demoShown = false;

function demoSeen(): boolean {
  if (demoShown) return true;
  try {
    return globalThis.localStorage?.getItem(DEMO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDemoSeen(): void {
  demoShown = true;
  try {
    globalThis.localStorage?.setItem(DEMO_SEEN_KEY, "1");
  } catch {
    /* private mode: once per page load */
  }
}

export function SessionRuler({ paneId, agents, listGroup, stale }: SessionRulerProps) {
  const prefs = usePreferences();
  const board = useBoard();
  const [preview, setPreview] = useState<Preview>(IDLE);
  const [placement, setPlacement] = useState<PeekPlacement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const ticksRef = useRef<HTMLSpanElement | null>(null);
  const dragPointer = useRef<number | null>(null);
  const dragIndex = useRef<number | null>(null);
  const seen = useRef(demoSeen());
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const view = rulerView({
    agents,
    listGroup,
    activation: heldShownListOrder(prefs.paneActivated, agents.map((agent) => agent.paneId)),
    pinned: prefs.panePinned,
    currentPaneId: paneId,
    stale,
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const targetIndex = preview.phase === "idle" ? -1 : preview.index;
  const target = targetIndex >= 0 ? view.ticks[targetIndex] ?? null : null;
  const previewing = target !== null;
  const boardTarget = target ? agents.find((agent) => agent.paneId === target.paneId) : undefined;
  const currentAgent = agents.find((agent) => agent.paneId === paneId);
  const layout = boardTarget?.tabId
    ? board.layouts.find((entry) => entry.workspaceId === boardTarget.workspaceId && entry.tabId === boardTarget.tabId) ?? null
    : null;
  const quadrant = target && layout && layout.panes.length > 1 && !layout.zoomed
    ? panePosition(layout, target.paneId)
    : "";
  const relation = target ? rulerRelation(currentAgent, boardTarget) : "";
  const relationLabel = relation === "same-tab"
    ? [t("chrome.rulerSameTab"), quadrant].filter(Boolean).join(" · ")
    : relation === "same-workspace" ? t("chrome.rulerOtherTab")
      : relation === "other-workspace" ? t("chrome.rulerOtherWorkspace")
        : "";
  const mapBoxes = target && layout && layout.panes.length > 1
    ? rulerMapBoxes(layout, paneId, target.paneId)
    : [];
  const mapHasCurrent = mapBoxes.some((box) => box.current);

  function markSeen(): void {
    if (seen.current) return;
    seen.current = true;
    rememberDemoSeen();
  }

  // The first visit to a phone's pane shows what the ruler does: the next row
  // (the previous at the end) appears for a moment, then settles. Anything the
  // reader does before or during it ends it for good.
  useEffect(() => {
    if (!view.visible || seen.current || isDesk() || prefersReducedMotion()) return;
    let delay = 0;
    let hold = 0;
    const cancel = (): void => {
      window.clearTimeout(delay);
      window.clearTimeout(hold);
      seen.current = true;
      rememberDemoSeen();
      setPreview((value) => value.phase === "demo" ? IDLE : value);
    };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    delay = window.setTimeout(() => {
      const current = viewRef.current;
      if (seen.current || !current.visible || previewRef.current.phase !== "idle") return;
      if (isDesk() || prefersReducedMotion() || document.querySelector("dialog[open]")) return;
      const node = trackRef.current;
      if (!node || node.getBoundingClientRect().height <= 0) return;
      const next = current.currentIndex + 1 < current.ticks.length ? current.currentIndex + 1 : current.currentIndex - 1;
      if (next < 0 || next === current.currentIndex) return;
      setPreview({ phase: "demo", index: next });
      hold = window.setTimeout(() => {
        setPreview((value) => value.phase === "demo" ? IDLE : value);
        seen.current = true;
        rememberDemoSeen();
      }, DEMO_HOLD_MS);
    }, DEMO_DELAY_MS);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      window.clearTimeout(delay);
      window.clearTimeout(hold);
    };
  }, [view.visible]);

  useEffect(() => {
    if (view.visible) return;
    dragPointer.current = null;
    dragIndex.current = null;
    setPreview(IDLE);
  }, [view.visible]);

  useLayoutEffect(() => {
    if (targetIndex < 0 || !view.ticks.length) {
      setPlacement(null);
      return;
    }
    const place = (): void => {
      const track = trackRef.current;
      const ticks = ticksRef.current;
      if (!track || !ticks) {
        setPlacement(null);
        return;
      }
      const box = ticks.getBoundingClientRect();
      if (!box.width) {
        setPlacement(null);
        return;
      }
      const tick = ticks.children[targetIndex]?.getBoundingClientRect();
      const center = tick && tick.width ? tick.left + tick.width / 2 : box.left + ((targetIndex + 0.5) / view.ticks.length) * box.width;
      setPlacement(peekPlacement(track.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, center));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [targetIndex, view.ticks.length]);

  useEffect(() => () => {
    const node = trackRef.current;
    const id = dragPointer.current;
    if (node && id != null && node.hasPointerCapture?.(id)) node.releasePointerCapture(id);
  }, []);

  if (!view.visible) return null;

  const count = { n: String(view.currentIndex + 1), total: String(view.ticks.length) };
  const current = view.ticks[view.currentIndex]!;

  function indexAt(clientX: number): number | null {
    const box = ticksRef.current?.getBoundingClientRect();
    if (!box || !box.width) return null;
    if (clientX < box.left || clientX > box.right) return null;
    const ratio = (clientX - box.left) / box.width;
    return Math.min(view.ticks.length - 1, Math.max(0, Math.floor(ratio * view.ticks.length)));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.isPrimary === false) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const index = indexAt(event.clientX);
    // The count sits at the end of the band; a tap there is not a jump to the last row.
    if (index == null) return;
    event.preventDefault();
    markSeen();
    if (event.pointerType === "mouse") event.currentTarget.focus({ preventScroll: true });
    dragPointer.current = event.pointerId;
    dragIndex.current = index;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPreview(index === view.currentIndex ? IDLE : { phase: "drag", index });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (dragPointer.current !== event.pointerId) return;
    event.preventDefault();
    const index = indexAt(event.clientX);
    // Past either end the last tick still under the finger stays the target.
    if (index == null) return;
    dragIndex.current = index;
    setPreview((value) => {
      if (index === view.currentIndex) return value.phase === "drag" ? IDLE : value;
      return value.phase === "drag" && value.index === index ? value : { phase: "drag", index };
    });
  }

  function release(event: PointerEvent<HTMLDivElement>): void {
    dragPointer.current = null;
    dragIndex.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (dragPointer.current !== event.pointerId) return;
    const index = dragIndex.current;
    release(event);
    setPreview(IDLE);
    const tick = index == null ? null : view.ticks[index];
    if (!tick || tick.paneId === paneId) return;
    void switchSessionInPlace(tick.paneId, event.pointerType === "mouse");
  }

  function onPointerCancel(event: PointerEvent<HTMLDivElement>): void {
    if (dragPointer.current !== event.pointerId) return;
    release(event);
    setPreview(IDLE);
  }

  function onLostPointerCapture(event: PointerEvent<HTMLDivElement>): void {
    if (dragPointer.current !== event.pointerId) return;
    dragPointer.current = null;
    setPreview(IDLE);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const key = event.key;
    const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    const jump = key === "Home" ? 0 : key === "End" ? view.ticks.length - 1 : -1;
    if (!step && jump < 0) return;
    // The terminal's own key pipeline must never see the ruler's arrows.
    event.preventDefault();
    event.stopPropagation();
    markSeen();
    const index = step ? view.currentIndex + step : jump;
    if (index < 0 || index >= view.ticks.length || index === view.currentIndex) return;
    const tick = view.ticks[index];
    if (tick.paneId === paneId) return;
    void switchSessionInPlace(tick.paneId, true);
  }

  return <>
    <div
      ref={trackRef}
      className={`session-ruler${previewing ? " has-target" : ""}`}
      role="slider"
      aria-orientation="horizontal"
      aria-label={t("chrome.ruler")}
      aria-valuemin={1}
      aria-valuemax={view.ticks.length}
      aria-valuenow={view.currentIndex + 1}
      aria-valuetext={t("chrome.rulerValue", { ...count, title: current.title })}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
    >
      <span className="session-ruler-ticks" ref={ticksRef} aria-hidden="true">
        {view.ticks.map((tick, index) => {
          const className = ["session-ruler-tick"];
          if (tick.current) className.push("is-current");
          if (tick.blocked && !previewing) className.push("is-blocked");
          if (previewing && index === targetIndex) className.push("is-target");
          return <span key={tick.paneId} data-index={index} className={className.join(" ")} />;
        })}
      </span>
      <span className="session-ruler-count" aria-hidden="true">{t("chrome.rulerPosition", count)}</span>
    </div>
    {target && placement ? createPortal(
      <div
        className="session-ruler-peek"
        style={{ left: `${placement.left}px`, top: `${placement.top}px`, width: `${placement.width}px` }}
        aria-hidden="true"
      >
        <div className="session-ruler-peek-top">
          <span className="session-ruler-peek-position">{t("chrome.rulerPosition", { n: String(targetIndex + 1), total: count.total })}</span>
        </div>
        <div className="session-ruler-peek-id">
          <AgentAvatar
            kind={target.kind === "agent" ? target.agentKind : ""}
            status={target.kind === "agent" ? target.statusTone : undefined}
          />
          <span className="session-ruler-peek-copy">
            <span className="session-ruler-peek-title">{target.title}</span>
            <span className="session-ruler-peek-meta">
              {target.statusLabel
                ? <span className={`session-ruler-peek-status is-${target.statusTone}`}>{target.statusLabel}</span>
                : null}
              {target.line ? <span className="session-ruler-peek-line">{target.line}</span> : null}
            </span>
          </span>
        </div>
        {target.group || relationLabel ? <div className="session-ruler-peek-foot">
          {target.group
            ? <span className="session-ruler-peek-group">{target.group} · {target.groupWithin} / {target.groupCount}</span>
            : null}
          {relationLabel ? <span className="session-ruler-peek-pos">{relationLabel}</span> : null}
        </div> : null}
        {mapBoxes.length ? <>
          <div className="session-ruler-peek-key">
            {mapHasCurrent ? <span className="is-now"><i />{t("chrome.rulerNow")}</span> : null}
            <span className="is-target"><i />{t("chrome.rulerTarget")}</span>
          </div>
          <div className="session-ruler-peek-map">
            {mapBoxes.map((box) => {
              const className = [box.current ? "is-now" : "", box.target ? "is-target" : ""].filter(Boolean).join(" ");
              return <span key={box.paneId} className={className} style={{
                left: `${box.left * 100}%`,
                top: `${box.top * 100}%`,
                width: `${box.width * 100}%`,
                height: `${box.height * 100}%`,
              }} />;
            })}
          </div>
        </> : null}
      </div>,
      document.body,
    ) : null}
  </>;
}
