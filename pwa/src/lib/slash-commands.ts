/**
 * Slash tokens typed into the agent PTY. Pairfob does not interpret them:
 * unknown commands are the agent's problem after send.
 *
 * Phone 4×2 grid: start over on the first row, then goal / loop / usage /
 * help. Argument-taking tokens keep a trailing space so the caret sits
 * where the user types the rest.
 */
export type SlashCommand = {
  token: string;
  label: string;
  ariaKey?: "slash.goal" | "slash.loop";
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { token: "/clear", label: "/clear" },
  { token: "/new", label: "/new" },
  { token: "/compact", label: "/compact" },
  { token: "/model", label: "/model" },
  { token: "/goal ", label: "/goal", ariaKey: "slash.goal" },
  { token: "/loop ", label: "/loop", ariaKey: "slash.loop" },
  { token: "/usage", label: "/usage" },
  { token: "/help", label: "/help" },
];
