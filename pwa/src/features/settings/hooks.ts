import { useSyncExternalStore } from "react";
import { useDomain } from "../../shared/react/use-domain";
import type { ListGroup } from "../../lib/ranking";
import { paneTermMode, preferencesStore } from "./preferences-store";
import type { TermMode } from "../../lib/terminal-mode";
import type { QuickCommand } from "./quick-command-model";

/** React snapshot for the device-local preferences domain. Owned by the settings feature. */
export function usePreferences() {
  return useDomain(preferencesStore);
}

/**
 * One preference field, as the value it is.
 *
 * The preferences domain also publishes bookkeeping the reader does not see
 * (`paneTouched` on every tap) and the terminal font on every pinch move. A
 * control that reads a single field through `usePreferences()` repaints for all
 * of it; this subscribes to that field alone, so it must return a scalar.
 */
export function usePreferenceField<T extends string | number | boolean | null>(select: (prefs: ReturnType<typeof preferencesStore.get>) => T): T {
  return useSyncExternalStore(
    preferencesStore.subscribe,
    () => select(preferencesStore.get()),
    () => select(preferencesStore.get()),
  );
}

/** The edited commands, by content: a publish that copies the same list is no edit. */
const quickCommandsKey = () => JSON.stringify(preferencesStore.get().quickCommands ?? null);

/**
 * The reader's own quick commands, or null for the built-in set. The list is
 * copied into every published snapshot, so the subscription is its content, not
 * its identity: a tap elsewhere in the app must not rebuild the command pad.
 */
export function useQuickCommands(): readonly QuickCommand[] | null {
  useSyncExternalStore(preferencesStore.subscribe, quickCommandsKey, quickCommandsKey);
  return preferencesStore.get().quickCommands;
}

/**
 * The terminal mode of one pane, followed. The preferences domain publishes a
 * pinch, a font size and every other pane's choice too; this sheet draws one.
 */
export function usePaneTermMode(paneId: string): TermMode {
  return usePreferenceField(() => paneTermMode(paneId));
}

const listGroupOf = () => preferencesStore.get().listGroup;
const keysExpandedOf = () => preferencesStore.get().keysExpanded;

/** How rows below a header are named. The header does not follow a pinch or a tap. */
export function useListGroup(): ListGroup {
  return useSyncExternalStore(preferencesStore.subscribe, listGroupOf, listGroupOf);
}

/** Whether the extended key pad is folded out, for the controls that only draw it. */
export function useKeysExpanded(): boolean {
  return useSyncExternalStore(preferencesStore.subscribe, keysExpandedOf, keysExpandedOf);
}
