/**
 * Presentation tone vocabulary for connection status.
 *
 * `state.ts` keeps its own structurally identical union for the application
 * side; shared UI declares the one it paints so it never imports app state.
 */
export type StatusTone = "live" | "warn" | "off" | "demo" | "pending";

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span className={`dot dot-${tone}`} />;
}

export function StatusLine({ status }: { status: { tone: StatusTone; text: string } }) {
  return <p className="statusline"><StatusDot tone={status.tone} /><span className="statusline-text">{status.text}</span></p>;
}

export function Brand({ tone = null, heading = false }: { tone?: StatusTone | null; heading?: boolean }) {
  return <div className="brand tw:inline-flex tw:items-center tw:gap-[7px] tw:flex-none">
    {heading ? <h1 className="wordmark">pairfob</h1> : <span className="wordmark">pairfob</span>}
    <span className={`brand-dot${tone ? ` dot-${tone}` : ""}`} />
  </div>;
}
