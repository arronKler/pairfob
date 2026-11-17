import type { WebglAddon } from "@xterm/addon-webgl";
import type { ILinkHandler, ITerminalAddon, ITerminalOptions, Terminal } from "@xterm/xterm";
import { MIN_TEXT_CONTRAST } from "../../../lib/ansi-contrast";

type WebglRendererAddon = ITerminalAddon & Pick<WebglAddon, "onContextLoss">;
type WebglConstructor = new () => WebglRendererAddon;
export type RendererTerminal = Pick<Terminal, "loadAddon" | "open">;

export const WEBGL_UNAVAILABLE = "WebGL2 terminal renderer unavailable";
export const WEBGL_CONTEXT_LOST = "WebGL terminal renderer lost its graphics context";

export function supportsWebgl2(): boolean {
  try {
    const context = document.createElement("canvas").getContext("webgl2");
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function fullTerminalOptions(args: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  linkHandler: ILinkHandler;
  scrollback?: number;
}): ITerminalOptions {
  return {
    cursorBlink: true,
    cursorStyle: "block",
    convertEol: false,
    disableStdin: false,
    drawBoldTextInBrightColors: true,
    // The floor the guided view moves unreadable text to (lib/ansi-contrast.ts): text under it is moved to it, the rest is as sent.
    minimumContrastRatio: MIN_TEXT_CONTRAST,
    customGlyphs: true,
    fontFamily: args.fontFamily,
    fontSize: args.fontSize,
    lineHeight: args.lineHeight,
    letterSpacing: 0,
    scrollback: args.scrollback ?? 0,
    linkHandler: args.linkHandler,
    theme: {
      background: "#090c10",
      foreground: "#e7ebf1",
      cursor: "#8ab4ff",
      cursorAccent: "#090c10",
      selectionBackground: "#305a8a99",
    },
  };
}

/**
 * Install WebGL before open so xterm never mounts its inline-style DOM
 * renderer. The hosted PWA deliberately keeps a strict style-src CSP.
 */
export function openWebglTerminal(
  terminal: RendererTerminal,
  Webgl: WebglConstructor,
  mount: HTMLElement,
  onContextLoss: () => void,
): void {
  const renderer = new Webgl();
  renderer.onContextLoss(onContextLoss);
  terminal.loadAddon(renderer);
  terminal.open(mount);

  // xterm catches addon activation errors during open and silently installs
  // its DOM renderer, so verify which renderer actually won.
  if (mount.querySelector(".xterm-rows") || !mount.querySelector(".xterm-screen canvas")) {
    throw new Error(WEBGL_UNAVAILABLE);
  }
}

/** Plain text of the visible viewport, including the alternate screen used by TUIs. */
export function terminalScreenText(terminal: Pick<Terminal, "rows" | "buffer">): string {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
  ).join("\n");
}
