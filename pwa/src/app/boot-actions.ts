/** The boot page requests recovery without importing the application bootstrap. */
let retryStorage: (() => void) | null = null;

export function bindBootStorageRetry(retry: () => void): () => void {
  retryStorage = retry;
  return () => { if (retryStorage === retry) retryStorage = null; };
}

export function requestBootStorageRetry(): void {
  retryStorage?.();
}
