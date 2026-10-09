import { Globe, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { ThisDeviceIcon } from "../../features/settings/this-device";
import { t } from "../../lib/i18n";

/**
 * The real route a session takes — this device → pairfob.com → the computer —
 * with the stuck or broken hop marked. It says where the problem is, which
 * decides what the reader can do about it.
 */
export type HopState = "ok" | "wait" | "fail" | "idle";
export type PathNode = { state: HopState; note: string };

export function ConnectionPathCard({ host, phone, link1, relay, link2, computer, children }: {
  host: string;
  phone: PathNode;
  link1: HopState;
  relay: PathNode;
  link2: HopState;
  computer: PathNode;
  children?: ReactNode;
}) {
  const label = t("path.aria", { phone: phone.note, relay: relay.note, host, computer: computer.note });
  return (
    <section className="conn-path-card">
      <div className="conn-path" role="img" aria-label={label}>
        <Node node={phone} icon={<ThisDeviceIcon size={20} />} name={t("path.phone")} />
        <span className={`conn-link is-${link1}`} aria-hidden="true" />
        <Node node={relay} icon={<Globe size={20} />} name="pairfob.com" />
        <span className={`conn-link is-${link2}`} aria-hidden="true" />
        <Node node={computer} icon={<Monitor size={20} />} name={host} />
      </div>
      {children}
    </section>
  );
}

function Node({ node, icon, name }: { node: PathNode; icon: ReactNode; name: string }) {
  return (
    <span className={`conn-node is-${node.state}`} aria-hidden="true">
      <span className="conn-node-icon">{icon}</span>
      <b>{name}</b>
      <small>{node.note}</small>
    </span>
  );
}
