type PaneRefresh = () => Promise<void>;

let refreshPane: PaneRefresh | null = null;

/** Bind the live-session owner without making terminal input import it back. */
export function bindPaneRefresh(refresh: PaneRefresh): void {
  refreshPane = refresh;
}

/** Request a read after an ordered terminal mutation; an unmounted UI is a no-op. */
export function requestPaneRefresh(): Promise<void> {
  return refreshPane?.() ?? Promise.resolve();
}
