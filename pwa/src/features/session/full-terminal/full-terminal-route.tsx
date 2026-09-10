import { sessionHandlers } from "../pane-actions";
import { FullTerminalScreen, type FullTerminalScreenProps } from "./full-terminal-screen";
import {
  fullTerminalControlOptions,
  interruptFullTerminal,
  pageScrollLines,
  retryFullTerminal,
  sendFullTerminalScroll,
} from "./full-terminal";
/**
 * Declarative complete-terminal route.
 *
 * `<App/>` composes this for the full-terminal layout instead of the controller
 * injecting an adopted screen. It only assembles the existing
 * {@link FullTerminalScreen} with the stable session handlers and the feature's
 * own controller ports; it never creates a root, adopts a screen, or paints.
 *
 * Engine attach, status and props stay owned by the controller and the
 * `FullTerminalHost` layout effect; this route is presentation composition.
 */
export function FullTerminalRoute(): React.ReactElement {
  const { onBack, onWorkspace, onMenu } = sessionHandlers();
  const props: FullTerminalScreenProps = {
    onBack,
    onWorkspace,
    onMenu,
    onStop: interruptFullTerminal,
    onRetry: retryFullTerminal,
    scroll: sendFullTerminalScroll,
    pageLines: pageScrollLines,
    controls: fullTerminalControlOptions(),
  };
  return <FullTerminalScreen {...props} />;
}
