import { createElement, useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { app } from "../../state";
import { setFullTerminalDocumentMode } from "../full-terminal-state";
import { getFullTerminalView, subscribeFullTerminalView } from "../full-terminal-view";
import { state } from "../../state";
import type { FullTerminalControlsOptions } from "../full-terminal-compose";
import type { RemoteScroll } from "../full-terminal-scroll";
import { FullTerminalPad } from "./full-terminal-pad";
import { FullTerminalHost } from "./full-terminal-host";
import { BackButton } from "./chrome";
import { SessionActions } from "./session-chrome";
import { leaveReactScreen, renderReactScreen } from "./root";
import type { FullTerminalViewSnapshot } from "../full-terminal-view";

export type FullTerminalScreenProps = {
  onBack: () => void;
  onWorkspace: () => void;
  onMenu: () => void;
  onStop: () => void;
  onRetry: () => void;
  scroll: RemoteScroll;
  pageLines: () => number;
  controls: FullTerminalControlsOptions;
  engineActive?: boolean;
};

/**
 * Complete-terminal shell for the session root.
 *
 * DOM: `.pane-root.full-terminal-root[data-pane-id] > header.chrome.full-terminal-chrome`
 * then `.full-terminal-host` (state, scroll rail, pan/canvas) then `.full-terminal-pad`.
 * Persist one React root; do not remount the canvas per snapshot. Engine attach
 * runs after commit. `finishSessionPaint` is not used here.
 *
 * Host classes `is-pan` / `kb-on` / `kb-off` are engine-owned — this tree must
 * not overwrite them with a React `className` on `.full-terminal-host`.
 */
export function FullTerminalScreen(props: FullTerminalScreenProps) {
  const view = useSyncExternalStore(subscribeFullTerminalView, getFullTerminalView);
  return <FullTerminalBody key={view.owner} view={view} {...props} />;
}

function FullTerminalBody({ view, onBack, onWorkspace, onMenu, onStop, onRetry, scroll, pageLines, controls, engineActive = state.fullTerminal }: FullTerminalScreenProps & { view: FullTerminalViewSnapshot }) {
  return (
    <div className="pane-root full-terminal-root" data-pane-id={view.paneId} data-terminal-owner={view.owner} data-react-full-terminal="">
      <header className="chrome full-terminal-chrome">
        <BackButton onBack={onBack} label={t("chrome.backList")} />
        <div className="full-terminal-heading">
          <strong className="full-terminal-title">{view.title}</strong>
          <span className="full-terminal-status">{view.detail}</span>
        </div>
        <SessionActions
          onWorkspace={onWorkspace}
          onMenu={onMenu}
          onStop={onStop}
          working={view.working}
        />
      </header>
      <FullTerminalHost
        paneId={view.paneId}
        active={engineActive}
        onRetry={onRetry}
        scroll={scroll}
        pageLines={pageLines}
      />
      <FullTerminalPad options={controls} />
    </div>
  );
}

export function paintFullTerminalScreen(props: FullTerminalScreenProps): void {
  setFullTerminalDocumentMode(true);
  renderReactScreen(createElement(FullTerminalScreen, props));
}

/** Flush-unmount the persist root. Call before any `app.replaceChildren()` in tests. */
export function releaseFullTerminalScreen(): void {
  if (app.querySelector("[data-react-full-terminal]")) leaveReactScreen();
}
