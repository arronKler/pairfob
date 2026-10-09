import { useHardwareKeyboard } from "../../../app/input-mode";
import { sessionHandlers } from "../pane-actions";
import { FullTerminalScreen, type FullTerminalScreenProps } from "./full-terminal-screen";
import {
  fullTerminalControlOptions,
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
export function FullTerminalRoute({ includeBack = true, onBack: back }: {
  /** The desk shows the terminal beside the list, so it has no back of its own. */
  includeBack?: boolean;
  onBack?: () => void;
} = {}): React.ReactElement {
  const { onBack, onWorkspace, onMenu } = sessionHandlers();
  // The controls read the keyboard as it is now: a tablet proves one with a key, and
  // live input is xterm's from that key on, not from whatever commits next.
  useHardwareKeyboard();
  const props: FullTerminalScreenProps = {
    onBack: back ?? onBack,
    includeBack,
    onWorkspace,
    onMenu,
    onRetry: retryFullTerminal,
    scroll: sendFullTerminalScroll,
    pageLines: pageScrollLines,
    controls: fullTerminalControlOptions(),
  };
  return <FullTerminalScreen {...props} />;
}
