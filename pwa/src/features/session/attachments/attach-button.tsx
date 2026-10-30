import { Paperclip } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "../../../shared/ui/primitives/button";
import { computersStore } from "../../computers/catalog-store";
import { connectionStore } from "../../connection/connection-store";
import { capabilitiesStore } from "../../operations/capabilities-store";
import { sessionStore } from "../session-store";
import { haptic } from "../../../lib/dom";
import { attachT } from "./attach-copy";
import { attachmentsAllowed } from "./attachments-controller";
import { openAttachmentPicker } from "./attach-picker";

/** Stable across renders: an inline subscribe would detach and reattach on every one. */
function subscribeAttachAllowed(listener: () => void): () => void {
  const unsubs = [
    sessionStore.subscribe(listener),
    computersStore.subscribe(listener),
    connectionStore.subscribe(listener),
    capabilitiesStore.subscribe(listener),
  ];
  return () => unsubs.forEach((unsubscribe) => unsubscribe());
}

/**
 * The one attach affordance, mounted in every compose mode (guided, agent
 * chat, full terminal batch and full terminal live). Hidden (never merely
 * disabled-looking) unless the session is live on an open pane and the
 * computer advertises file upload support.
 *
 * A tap opens the system picker directly. Picked files go straight to the
 * tray and upload as soon as a direct connection allows. The file input
 * itself is page-owned (see attach-picker): this button comes and goes with
 * the capability grant, and a selection must outlive it.
 */
export function AttachButton() {
  const allowed = useSyncExternalStore(subscribeAttachAllowed, attachmentsAllowed, attachmentsAllowed);
  if (!allowed) return null;
  return <Button
    type="button"
    className="attach-btn"
    aria-label={attachT("tray.pick")}
    onClick={() => {
      haptic(2);
      openAttachmentPicker();
    }}
  >
    <Paperclip className="attach-glyph" size={20} aria-hidden="true" />
  </Button>;
}
