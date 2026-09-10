import { batch } from "../../shared/model/domain-store";
import { setScreen } from "../../app/navigation-store";
import { setAgentChat, setFullTerminal, selectPane } from "../session/session-store";
import { applyComposeDraft, bumpViewIncarnation, captureComposeDraft } from "../session/drafts/compose-drafts";
import { bindSessionOwnerFromLive } from "../session/bind-live";
import { commitView } from "../../app/host";
import { clearNotice } from "../../app/notices-store";
import type { WorkspaceReturnView } from "./model";

/**
 * Temporary enter/leave bridge until App owns screen composition.
 * Integration must replace `setWorkspaceNavigationSeam`; this must not remain
 * the data-update or global-repaint path. Feature loads never call
 * `applyIdentity` or `paint`. `notifyApp` is only for app-owned flags such as
 * operationBusy.
 */
export type WorkspaceAppNavigation = {
  screen: "workspace" | "pane" | "home";
  paneId?: string;
  fullTerminal?: boolean;
  agentChat?: boolean;
};

export type WorkspaceNavigationSeam = {
  /** Set screen/pane identity without painting. Leave restore batches draft with this. */
  applyIdentity(next: WorkspaceAppNavigation): void;
  paint(): void;
  notifyApp(): void;
};

function writeIdentity(next: WorkspaceAppNavigation): void {
  batch(() => {
    if (next.paneId !== undefined) selectPane(next.paneId);
    setScreen(next.screen);
    if (next.fullTerminal !== undefined) setFullTerminal(next.fullTerminal);
    if (next.agentChat !== undefined) setAgentChat(next.agentChat);
  });
}

const defaultSeam: WorkspaceNavigationSeam = {
  applyIdentity: writeIdentity,
  paint() {
    commitView();
  },
  notifyApp() {
    commitView();
  },
};

let seam: WorkspaceNavigationSeam = defaultSeam;

export function setWorkspaceNavigationSeam(next: WorkspaceNavigationSeam): void {
  seam = next;
}

export function resetWorkspaceNavigationSeam(): void {
  seam = defaultSeam;
}

export function applyWorkspaceNavigation(next: WorkspaceAppNavigation): void {
  seam.applyIdentity(next);
  seam.paint();
}

export function notifyWorkspaceApp(): void {
  seam.notifyApp();
}

export function prepareWorkspaceEnter(): void {
  captureComposeDraft();
  bumpViewIncarnation();
  clearNotice();
}

export function restoreWorkspaceLeave(paneId: string, returnView: WorkspaceReturnView): void {
  clearNotice();
  batch(() => {
    seam.applyIdentity({
      screen: "pane",
      paneId,
      fullTerminal: returnView === "full",
      agentChat: returnView === "agent",
    });
    bindSessionOwnerFromLive();
    applyComposeDraft();
  });
  seam.paint();
}

export function leaveWorkspaceToHome(): void {
  clearNotice();
  applyWorkspaceNavigation({ screen: "home" });
}
