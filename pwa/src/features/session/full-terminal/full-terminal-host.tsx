import { memo, useLayoutEffect, useRef } from "react";
import { termFit } from "../../settings/preferences-store";
import { haptic } from "../../../lib/dom";
import { t } from "../../../lib/i18n";
import { attachFullTerminalHost } from "./full-terminal-engine";
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
  const rootRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

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
      <div className="full-terminal-pan">
        <FullTerminalCanvas />
      </div>
    </div>
  );
}, (prev, next) => prev.paneId === next.paneId && prev.active === next.active);
