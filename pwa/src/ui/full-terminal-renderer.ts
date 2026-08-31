import type { WebglAddon } from "@xterm/addon-webgl";
import type { ILinkHandler, ITerminalAddon, ITerminalOptions, Terminal } from "@xterm/xterm";

type WebglRendererAddon = ITerminalAddon & Pick<WebglAddon, "onContextLoss">;
type WebglConstructor = new () => WebglRendererAddon;
export type RendererTerminal = Pick<Terminal, "loadAddon" | "open">;

export const WEBGL_UNAVAILABLE = "WebGL2 terminal renderer unavailable";
export const WEBGL_CONTEXT_LOST = "WebGL terminal renderer lost its graphics context";

export function supportsWebgl2(): boolean {
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

export function fullTerminalOptions(args: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  linkHandler: ILinkHandler;
}): ITerminalOptions {
  return {
    cursorBlink: true,
    cursorStyle: "block",
    convertEol: false,
    disableStdin: false,
    drawBoldTextInBrightColors: true,
    customGlyphs: true,
    fontFamily: args.fontFamily,
    fontSize: args.fontSize,
    lineHeight: args.lineHeight,
    letterSpacing: 0,
    scrollback: 0,
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
  if (!supportsWebgl2()) throw new Error(WEBGL_UNAVAILABLE);
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
