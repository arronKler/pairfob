import { presentModal, type ModalController } from "../../shared/ui/overlay/modal";
import { CommandPalette, type PaletteRun } from "./palette";
import { commandPalettePorts } from "./ports";

let open: ModalController<PaletteRun> | null = null;

/**
 * Open search-and-jump over the application.
 *
 * One palette at a time: asking again while it is up returns to its field.
 * Another dialog keeps the screen — jumping away underneath a confirmation or a
 * sheet would strand it — so the request is dropped until that one is closed.
 */
export function openCommandPalette(): void {
  const ports = commandPalettePorts();
  if (!ports) return;
  if (open?.dialog.current?.open) {
    const field = open.dialog.current.querySelector("input");
    field?.focus();
    field?.select();
    return;
  }
  if (document.querySelector("dialog[open]")) return;
  const modal = presentModal<PaletteRun>((controller) => <CommandPalette modal={controller} ports={ports} />);
  open = modal;
  void modal.result.then((run) => {
    if (open === modal) open = null;
    // Like a sheet's follow-up: on the next task, after native close and React
    // teardown, so a dialog the jump opens is not taken down with this one.
    if (run) window.setTimeout(run, 0);
  });
}
