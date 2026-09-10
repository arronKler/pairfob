/**
 * Ports the connection controllers need from session, shell, credentials and
 * observation. Feature modules never import ui/, paint.ts or the legacy record;
 * the live.ts adapter supplies these callbacks.
 */
import type { PairResult } from "../../lib/protocol/client";
import type { NoticeScope } from "../../lib/notice-scope";

export type SessionLeavePorts = {
  captureComposeDraft(): void;
  dropQueuedKeys(): void;
  disposeGuidedScroll(): void;
  disposeFullTerminal(): void;
  leaveFullTerminal(): Promise<void>;
  isFullTerminal(): boolean;
};

export type ShellPorts = {
  /**
   * Apply `#app` classes, scroll lock and terminal CSS vars. Retires when core's
   * declarative shell owns those. Never call from a React render.
   */
  commitView(): void;
  documentVisible(): boolean;
};

export type NoticePorts = {
  showError(text: string, scopeOrPersist?: NoticeScope | boolean, persist?: boolean): void;
  showStatus(text: string, persist?: boolean, scope?: NoticeScope): void;
  clearNotice(): void;
};

export type CredentialPorts = {
  loadCatalog(origin: string): Promise<{ credentials: PairResult[]; lastUsedDaemonId: string | null }>;
  rememberLastUsed(daemonId: string): Promise<void>;
  saveCredential(pair: PairResult): Promise<void>;
  deleteCredential(daemonId: string): Promise<void>;
};

export type ObservationPorts = {
  startPolling(): void;
  stopPolling(): void;
  refreshRuntime(): Promise<void>;
  resetPaneReads(): void;
  setRefreshIdle(): void;
};

export type LifecyclePorts = SessionLeavePorts &
  ShellPorts &
  NoticePorts &
  CredentialPorts &
  ObservationPorts & {
    track(name: string, data?: Record<string, string>): void;
    origin(): string;
  };
