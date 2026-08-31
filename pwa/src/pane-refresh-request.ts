export type PaneRefreshRequest = {
  /** Do not share a read that started before this monotonic timestamp. */
  notBefore?: number;
  /** Move the fallback poll after this explicit confirmation read. */
  postponeFallback?: boolean;
};

export type PaneReadObservation = {
  paneId: string;
  text: string;
  hash: string;
  changed: boolean;
  startedAt: number;
  completedAt: number;
};

type PaneRefresh = (request?: PaneRefreshRequest) => Promise<PaneReadObservation | null>;

let refreshPane: PaneRefresh | null = null;

/** Bind the live-session owner without making terminal input import it back. */
export function bindPaneRefresh(refresh: PaneRefresh): void {
  refreshPane = refresh;
}

/** Request a read after an ordered terminal mutation; an unmounted UI is a no-op. */
export function requestPaneRefresh(request?: PaneRefreshRequest): Promise<PaneReadObservation | null> {
  return refreshPane?.(request) ?? Promise.resolve(null);
}
