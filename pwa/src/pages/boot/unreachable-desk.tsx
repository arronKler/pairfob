import { t } from "../../lib/i18n";
import { createHerdActions } from "../../features/dashboard/actions";
import { RailFoot, RailHead, RailSearch } from "../../features/dashboard/components/rail-chrome";
import { herdActionPorts, unreachableHerdView } from "../home/herd-bridge";
import { openUnreachableSheet, UnreachableBody, unreachableHost } from "./unreachable-shell";

/** The rail's own intents; its title opens this page's computer panel, since no session backs the live one. */
const actions = createHerdActions({ ...herdActionPorts(), openHostMenu: openUnreachableSheet });

/**
 * The only paired computer could not be reached, beside the list: the desk
 * counterpart of the phone page inside its tab bar. The rail keeps its frame —
 * the computer and why in its head, where the reader can retry, add or forget
 * it — with nothing listed and nothing to search or open, as the phone's tab
 * bar locks Board and Settings. The explanation is the main column's page, one
 * centred column like Settings, with the retry under its steps.
 *
 * It is one tree in the pick phase and while its own retry runs, so the list
 * frame does not blink between attempts.
 */
export function UnreachableDesk({ retrying = false }: { retrying?: boolean }) {
  const { name, line, relay } = unreachableHost();
  const view = unreachableHerdView({ name, line, tone: "off" });
  return (
    <>
      <aside className="rail">
        <RailHead view={view} actions={actions} />
        <RailSearch disabled />
        <div className="rail-list">
          <p className="herd-empty-note" role="status">{t("empty.reconnectNote")}</p>
        </div>
        <RailFoot view={view} actions={actions} disabled />
      </aside>
      <section className="main main-unreachable">
        <h2 className="unreachable-title">{t("unreach.deskTitle", { target: relay ? "pairfob.com" : name })}</h2>
        <UnreachableBody retrying={retrying} />
      </section>
    </>
  );
}
