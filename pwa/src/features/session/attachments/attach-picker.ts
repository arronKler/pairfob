/**
 * The one native file input behind every attach button.
 *
 * It lives on `<body>` for the life of the page, outside React. Returning from
 * the system picker brings the page back to the foreground, and the foreground
 * recovery clears capabilities before its `GetConfig` lands — which unmounts
 * the attach button. An input owned by that button is detached before its
 * `change` arrives, React never hears it, and the selection is dropped with no
 * trace. This input cannot be unmounted, so the selection always reaches
 * `acceptFiles`, whose own readiness wait covers the capability gap.
 */
import type { AttachmentScope } from "./attach-model";
import { currentAttachmentScope } from "./attachments-context";
import { restoreAttachmentScope } from "./attachments-recovery";
import { acceptFiles } from "./attachments-tray-actions";

let input: HTMLInputElement | null = null;
/** The pane that opened the picker; a selection never lands in another pane. */
let owner: AttachmentScope | null = null;

function onChange(event: Event): void {
  const target = event.currentTarget as HTMLInputElement;
  const files = target.files ? Array.from(target.files) : [];
  // Clearing lets the same file be picked again; a cancelled pick leaves
  // nothing behind.
  target.value = "";
  const scope = owner;
  owner = null;
  if (!scope || !files.length) return;
  void restoreAttachmentScope(scope);
  void acceptFiles(scope, files);
}

function nativeInput(): HTMLInputElement {
  if (input?.isConnected) return input;
  input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.tabIndex = -1;
  input.className = "attach-native-input";
  input.setAttribute("aria-hidden", "true");
  input.addEventListener("change", onChange);
  document.body.append(input);
  return input;
}

/**
 * Open the system picker for the current pane — one multi-select file input,
 * so the OS offers its own photo library / camera / files menu. Must run
 * inside the tap that asked for it.
 */
export function openAttachmentPicker(): void {
  const scope = currentAttachmentScope();
  if (!scope) return;
  owner = scope;
  nativeInput().click();
}

/** Test/teardown helper. */
export function resetAttachmentPicker(): void {
  input?.remove();
  input = null;
  owner = null;
}
