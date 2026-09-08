import { act } from "react";

/** Close owned portals before retiring legacy dialogs; never steal React nodes. */
export function closeTestDialogs(): void {
  act(() => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
      dialog.close("cancel");
      if (!dialog.hasAttribute("data-react-modal")) dialog.remove();
    }
  });
}
