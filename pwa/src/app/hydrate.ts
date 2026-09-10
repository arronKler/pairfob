import { batch } from "../shared/model/domain-store";
import { browserEnvironment } from "./environment";
import type { DomainEnvironment } from "../shared/model/domain-environment";
import { hydrateConnection } from "../features/connection/connection-store";
import { hydratePreferences } from "../features/settings/preferences-store";
import { adoptDefaultComposeLive } from "../features/session/compose-store";

/**
 * Browser hydration boundary.
 *
 * Domain models initialize from pure defaults so importing them needs no browser
 * global. The boot lifecycle calls this once, before the first mount, to adopt
 * the facts only a browser knows: reachability, the stored transport preference,
 * the stored terminal/list/pad choices and the responsive default font size.
 *
 * One batch, so the first paint sees a coherent set of domains instead of a
 * partially hydrated application.
 */
export function hydrateApplicationState(environment: DomainEnvironment = browserEnvironment()): void {
  batch(() => {
    hydrateConnection(environment);
    hydratePreferences(environment);
    adoptDefaultComposeLive();
  });
}
