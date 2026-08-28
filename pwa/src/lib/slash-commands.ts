/**
 * Slash tokens typed into the agent PTY. Pairfob does not interpret them:
 * unknown commands are the agent's problem after 发送.
 *
 * Phone 4×2 grid: start over on the first row, then goal / loop / usage /
 * help. Argument-taking tokens keep a trailing space so the caret sits
 * where the user types the rest.
 */
export type SlashCommand = {
  token: string;
  label: string;
  aria?: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { token: "/clear", label: "/clear" },
  { token: "/new", label: "/new" },
  { token: "/compact", label: "/compact" },
  { token: "/model", label: "/model" },
  { token: "/goal ", label: "/goal", aria: "插入 /goal，接着填目标" },
  { token: "/loop ", label: "/loop", aria: "插入 /loop，接着填参数" },
  { token: "/usage", label: "/usage" },
  { token: "/help", label: "/help" },
];
