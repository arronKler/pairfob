export const TERM_MODE_OPTIONS = ["auto", "guided", "full", "agent"] as const;

export type TermMode = (typeof TERM_MODE_OPTIONS)[number];
export type ActiveTermMode = Exclude<TermMode, "auto">;

export type TermModeContext = {
  p2p: boolean;
  fullTerminalAvailable: boolean;
};

export function parseTermMode(raw: string | null | undefined, fallback: TermMode = "auto"): TermMode {
  return TERM_MODE_OPTIONS.includes(raw as TermMode) ? raw as TermMode : fallback;
}

/** Resolve the persisted preference once when a pane opens; explicit choices always win. */
export function resolveTermMode(preference: TermMode, context: TermModeContext): ActiveTermMode {
  if (preference !== "auto") return preference;
  return context.p2p && context.fullTerminalAvailable ? "full" : "guided";
}
