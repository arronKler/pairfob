export type ConnectionPhase = "connected" | "verifying" | "connecting" | "disconnected";

type PhaseSource = {
  isConnected: () => boolean;
  isChecking?: () => boolean;
  connectionPhase?: () => ConnectionPhase;
};

export function connectionPhaseOf(session: PhaseSource | null | undefined): ConnectionPhase {
  if (!session) return "disconnected";
  if (session.connectionPhase) return session.connectionPhase();
  if (session.isConnected()) return "connected";
  return session.isChecking?.() ? "connecting" : "disconnected";
}