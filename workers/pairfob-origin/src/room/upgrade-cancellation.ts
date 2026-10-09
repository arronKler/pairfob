interface UpgradeEndpoint {
  accept(): void;
  close(code: number, reason: string): void;
}

interface RoomEndpoint {
  close(code: number, reason: string): void;
}

/** Close both local endpoints if cancellation wins the race with response handoff. */
export function watchUpgradeCancellation(
  signal: AbortSignal,
  client: UpgradeEndpoint,
  server: RoomEndpoint,
  onCanceled: () => void,
): void {
  const cancel = () => {
    try {
      // A handed-off endpoint rejects accept(). Never close its established peer.
      // readyState cannot distinguish an unclaimed endpoint from a handed-off one.
      client.accept();
    } catch (error) {
      if (error instanceof TypeError && error.message === "Can't accept() WebSocket that was already used in a response.") return;
      throw error;
    }
    // Closing only the client leaves its read loop waiting for the server's close
    // reply. That pending I/O prevents the Durable Object from hibernating.
    try {
      client.close(1000, "upgrade_cancelled");
    } finally {
      server.close(1000, "upgrade_cancelled");
    }
    onCanceled();
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
}
