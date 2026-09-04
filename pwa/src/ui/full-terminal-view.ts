import { node } from "../lib/dom";
import { t } from "../lib/i18n";
import { backButton } from "./chrome";
import { scrollRail, type RemoteScroll } from "./full-terminal-scroll";
import { fullTerminalStateLayer } from "./full-terminal-state";
import { chromeActionCluster } from "./session/chrome-actions";

export type FullTerminalViewActions = {
  onBack: () => void;
  onWorkspace: () => void;
  onMenu: () => void;
  onRetry: () => void;
  onScroll: RemoteScroll;
  pageLines: () => number;
};

export type FullTerminalView = {
  root: HTMLElement;
  host: HTMLElement;
};

/** Build the stable complete-terminal shell; xterm lifecycle stays in the controller. */
export function createFullTerminalView(
  paneId: string,
  title: string,
  statusDetail: string,
  panMode: boolean,
  actions: FullTerminalViewActions,
): FullTerminalView {
  const root = node("div", "pane-root full-terminal-root");
  root.dataset.paneId = paneId;
  const chrome = node("header", "chrome full-terminal-chrome");
  const titleWrap = node("div", "full-terminal-heading");
  titleWrap.append(
    node("strong", "full-terminal-title", title),
    node("span", "full-terminal-status", statusDetail),
  );
  chrome.append(
    backButton(actions.onBack, t("chrome.backList")),
    titleWrap,
    chromeActionCluster(actions.onWorkspace, actions.onMenu),
  );

  const host = node("div", "full-terminal-host");
  host.setAttribute("aria-label", t("title.terminal"));
  if (panMode) host.classList.add("is-pan");
  const pan = node("div", "full-terminal-pan");
  pan.append(node("div", "full-terminal-canvas"));
  host.append(
    fullTerminalStateLayer(actions.onRetry),
    scrollRail(actions.onScroll, actions.pageLines),
    pan,
  );
  root.append(chrome, host);
  return { root, host };
}

export function updateFullTerminalTitle(root: ParentNode, title: string): void {
  const heading = root.querySelector<HTMLElement>(".full-terminal-title");
  if (heading) heading.textContent = title;
}
