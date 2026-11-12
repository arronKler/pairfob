/**
 * The session ruler's switch.
 *
 * The ruler sits in headers the connection controller reaches through the
 * complete terminal and the chat, so importing that controller here would close
 * an import cycle. The controller binds `openPane(..., { inPlace: true })` at
 * load; the ruler only names the intent. After the switch lands, the ruler that
 * replaced the old one takes the keyboard back when the reader was using it.
 */
import { currentScreen } from "../../../app/navigation-store";
import { openPaneId } from "../session-store";

type SwitchPane = (paneId: string) => Promise<void>;

let switchPane: SwitchPane | null = null;

export function bindSessionSwitch(next: SwitchPane | null): void {
  switchPane = next;
}

export async function switchSessionInPlace(paneId: string, keepFocus: boolean): Promise<void> {
  if (!paneId || paneId === openPaneId()) return;
  await switchPane?.(paneId);
  if (!keepFocus || currentScreen() !== "pane" || openPaneId() !== paneId) return;
  document.querySelector<HTMLElement>(".session-ruler")?.focus({ preventScroll: true });
}
