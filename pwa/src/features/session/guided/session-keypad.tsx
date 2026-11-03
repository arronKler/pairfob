import { ChevronDown, Ellipsis } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../../lib/i18n";
import { useKeysExpanded } from "../../settings/hooks";
import { keysExpanded, setKeysExpanded } from "../../settings/preferences-store";
import {
  PRIMARY_KEYS,
  PAGE_KEYS,
  EXPANDED_KEYS,
  EXTRA_KEYS,
  clearModifiers,
  modifierSnapshot,
  subscribeModifiers,
} from "../keypad/keypad";
import { useModifierScope } from "../keypad/modifier-scope";
import { PadKey } from "../keypad/pad-key";
import { PadPanel, type PadPanelState } from "../keypad/pad-panel";
import { useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { queueKey, sendPage } from "./keys";
import { PadChromeButton } from "../compose-focus";
import { SessionSlashPad } from "./session-slash-pad";
import { liftGuidedPane, resetGuidedLift } from "./pad-lift";

const sendKey = (key: string) => (el: HTMLElement) => queueKey(key, el);

/**
 * Guided keypad, floating above the one-row dock.
 *
 * The panel holds the complete pad a tap opens: the two paged rows, their
 * pager, and the primary row nearest the field. Its handle closes it; ⋯/⌄
 * folds it to the primary row and back without rebuilding the pages. Pages
 * keep their modifiers, so a lock made on one page still applies on the next.
 *
 * The pad and the soft keyboard are never shown together. Asking for the pad
 * from the field puts the keyboard away first, and touching the field closes
 * the pad. Opening the panel lifts the transcript's last line above it; it
 * takes no layout height, so the buffer does not reflow.
 *
 * `paging` is the mouse-driven dock: the hidden scroll rail's PgUp/PgDn live in
 * the primary row. `dense` is a phone on its side: one row of keys to a page.
 */
export function SessionKeyPad({ paging = false, dense = false }: { paging?: boolean; dense?: boolean } = {}) {
  useModifierScope();
  useSyncExternalStore(subscribeModifiers, modifierSnapshot, modifierSnapshot);
  const keyboard = useSoftKeyboardOpen();
  const expanded = useKeysExpanded() && !keyboard;
  const [panel, setPanel] = useState<PadPanelState>("pages");
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (expanded && !wasOpen.current) setPanel("pages");
    wasOpen.current = expanded;
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const node = panelRef.current;
    const term = node?.closest<HTMLElement>(".pane-root")?.querySelector<HTMLElement>(".term") ?? null;
    if (!node || !term) return;
    const update = (): void => liftGuidedPane(term, panelRef.current);
    update();
    const Observer = term.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return () => resetGuidedLift(term);
    const observer = new Observer(update);
    observer.observe(term);
    observer.observe(node);
    const inner = term.querySelector<HTMLElement>(".term-inner");
    if (inner) observer.observe(inner);
    return () => {
      observer.disconnect();
      resetGuidedLift(term);
    };
    // Folding to the rail and back is the pad changing what it covers now; a
    // resize report for that grow may arrive late, so the state itself refits.
  }, [expanded, panel]);

  if (!expanded) return null;
  const close = (): void => {
    clearModifiers();
    setKeysExpanded(false);
  };
  return <PadPanel panel={panel} onClose={close} panelRef={panelRef}>
    <SessionSlashPad rows={dense ? 1 : 2} keyItems={[...EXPANDED_KEYS, ...EXTRA_KEYS]
      .map((spec) => <PadKey key={spec.key} spec={spec} onPress={sendKey(spec.key)} />)} />
    <div className={paging ? "keys keys-paged" : "keys"} role="group" aria-label={t("keys.primary")}>
      {PRIMARY_KEYS.map((spec) => <PadKey key={spec.key} spec={spec} onPress={sendKey(spec.key)} />)}
      {paging && PAGE_KEYS.map((spec) => <PadKey key={spec.key} spec={spec}
        onPress={() => void sendPage(spec.key === "pageup" ? "up" : "down")} />)}
      <PadChromeButton
        type="button"
        className="key key-more"
        aria-label={t(panel === "pages" ? "pad.collapseAria" : "pad.expandAria")}
        aria-expanded={panel === "pages" ? "true" : "false"}
        onClick={() => setPanel(panel === "pages" ? "rail" : "pages")}
      >{panel === "pages" ? <ChevronDown size={20} aria-hidden="true" /> : <Ellipsis size={20} aria-hidden="true" />}</PadChromeButton>
    </div>
  </PadPanel>;
}