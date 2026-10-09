import { memo, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { termFit } from "../../settings/preferences-store";
import { haptic } from "../../../lib/dom";
import { langRevision, subscribeLang, t } from "../../../lib/i18n";
import { attachFullTerminalHost } from "./full-terminal-engine";
import { bindPanBar } from "./full-terminal-pan-bar";
import type { RemoteScroll } from "./full-terminal-scroll";
import { SessionScrollRail } from "../guided/session-scroll";
import { FullTerminalStateLayer } from "./full-terminal-state-layer";

/**
 * Stable canvas: React never lists children here so xterm can own `.xterm`,
 * canvases, and the helper textarea across chrome/status rerenders.
 */
const FullTerminalCanvas = memo(function FullTerminalCanvas() {
  return <div className="full-terminal-canvas" />;
}, () => true);

/**
 * Host class bits `is-pan` / `kb-on` / `kb-off` are engine-owned. This
 * component sets the base class once via classList and does not pass a
 * React `className` that would wipe those bits on snapshot updates.
 */
export const FullTerminalHost = memo(function FullTerminalHost({
  paneId,
  active,
  onRetry,
  scroll,
  pageLines,
}: {
  paneId: string;
  active: boolean;
  onRetry: () => void;
  scroll: RemoteScroll;
  pageLines: () => number;
}) {
  useSyncExternalStore(subscribeLang, langRevision);
  const rootRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (panRef.current && barRef.current) return bindPanBar(barRef.current, panRef.current);
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.classList.add("full-terminal-host");
    host.classList.toggle("is-pan", termFit() === "pan");
    rootRef.current = host.closest(".full-terminal-root");
    const root = rootRef.current;
    if (!root || !active) return;
    return attachFullTerminalHost(root, host);
  }, [paneId, active]);

  return (
    <div ref={hostRef} aria-label={t("title.terminal")}>
      <FullTerminalStateLayer onRetry={onRetry} />
      <SessionScrollRail
        scroll={(direction, lines, source) => {
          haptic(4);
          scroll(direction, lines, source);
        }}
        pageLines={pageLines}
      />
      <div ref={panRef} className="full-terminal-pan">
        <FullTerminalCanvas />
      </div>
      {/* Shown only where the pan row has no scrollbar of its own; the binding hides it otherwise. */}
      <div ref={barRef} className="full-terminal-pan-bar" aria-hidden="true">
        <span className="full-terminal-pan-thumb" />
      </div>
    </div>
  );
}, (prev, next) => prev.paneId === next.paneId && prev.active === next.active);
