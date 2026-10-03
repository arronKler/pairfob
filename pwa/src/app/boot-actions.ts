/** The boot page requests recovery without importing the application bootstrap. */
export type BootRecoveryActions = {
  /** Read the catalog and origin config again. */
  retry: () => void;
  /** The reader chose to pair again although saved computers were expected. */
  pairAnyway: () => void;
};

let actions: BootRecoveryActions | null = null;

export function bindBootRecovery(next: BootRecoveryActions): () => void {
  actions = next;
  return () => { if (actions === next) actions = null; };
}

export function requestBootRetry(): void {
  actions?.retry();
}

export function requestBootPairAnyway(): void {
  actions?.pairAnyway();
}
