import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { credential } from "../../features/computers/catalog-store";
import { phase as currentPhase } from "../../features/connection/connection-store";
import { Brand, Spinner } from "../../shared/ui/primitives";

/**
 * Boot route.
 *
 * Pure projection of the typed domains: the boot phase shows the reading copy,
 * the resuming phase shows the computer the boot decision is connecting to.
 * The commit pipeline prepares the composition before this renders, so the
 * canonical reads here are the values the page was composed for.
 */
export function BootScreen() {
  const current = credential();
  return <div className="boot">
    <Brand /><Spinner />
    <p className="boot-text">{currentPhase() === "boot" ? t("boot.reading")
      : t("boot.connecting", { name: current ? computerTitle(current) : t("boot.computer") })}</p>
  </div>;
}
