import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { useCredential } from "../../features/computers/hooks";
import { Brand, Spinner } from "../../shared/ui/primitives";
import { useBootBlocked, useConnectionPhase } from "../../features/connection/hooks";
import { BootRecovery } from "./boot-recovery";

/**
 * Boot route.
 *
 * Pure projection of the typed domains: the boot phase shows the reading copy,
 * the resuming phase shows the computer the boot decision is connecting to.
 * It subscribes to the two fields it draws, so the splash follows a credential
 * read or a phase change without waiting for a composition.
 *
 * A retry started from the "cannot reach" page never reaches this splash: the
 * layout keeps that page's frame up for it (`UnreachableDesk`), as the phone's
 * boot frame does, since a splash between attempts would hide the explanation.
 */
export function BootScreen() {
  const bootBlocked = useBootBlocked();
  const current = useCredential();
  const phase = useConnectionPhase();
  if (bootBlocked) return <div className="boot"><Brand /><BootRecovery block={bootBlocked} /></div>;
  return <div className="boot">
    <Brand /><Spinner />
    <p className="boot-text">{phase === "boot" ? t("boot.reading")
      : t("boot.connecting", { name: current ? computerTitle(current) : t("boot.computer") })}</p>
  </div>;
}
