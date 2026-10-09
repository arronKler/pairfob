import { createDomain } from "../../shared/model/domain-store";

/**
 * Whether the files-and-changes inspector sits beside the desk session.
 *
 * This is presentation state beside the pane, never a screen: the open pane
 * keeps polling, forwarding keys and holding its draft while the inspector is
 * open. The phone has no inspector and navigates to the workspace screen.
 *
 * `open` records what the reader chose. Whether the column is on screen is the
 * layout's answer (`isRoomy() && open`): a window that narrows keeps the choice
 * and shows the column again when it widens.
 */
const domain = createDomain("workspaceInspector", { open: false });
export const inspectorStore = domain.store;

export function inspectorOpen(): boolean {
  return domain.controller.read().open;
}

export function setInspectorOpen(open: boolean): void {
  if (domain.controller.read().open === open) return;
  domain.controller.write((record) => {
    record.open = open;
  });
}
