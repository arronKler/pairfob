import { Check, Globe, Monitor, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { ThisDeviceIcon } from "../../features/settings/this-device";
import { t } from "../../lib/i18n";
import { Swap } from "../../shared/ui/primitives";

/**
 * The real route a session takes — this device → pairfob.com → the computer —
 * with the stuck or broken hop marked. It says where the problem is, which
 * decides what the reader can do about it.
 *
 * The card is redrawn every second while it counts a wait, so nothing in it
 * moves for being drawn. A hop that changes state does: a link that comes
 * through is drawn across (the stylesheet, on the link's own class), the
 * node's check or cross pops in, and its note is swapped in.
 */
export type HopState = "ok" | "wait" | "fail" | "idle";
export type PathNode = {
  state: HopState;
  note: string;
  /**
   * What the note says, when its words carry a running count ("waiting 9 s").
   * The note is swapped in when this changes, so a count ticking up is not a
   * new note every second. Defaults to the note itself.
   */
  says?: string;
};

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
        <span className={`conn-link is-${link1}`} aria-hidden="true">
          {link1 === "fail" ? <X size={12} strokeWidth={3} /> : null}
        </span>
        <Node node={relay} icon={<Globe size={20} />} name="pairfob.com" />
        <span className={`conn-link is-${link2}`} aria-hidden="true">
          {link2 === "fail" ? <X size={12} strokeWidth={3} /> : null}
        </span>
        <Node node={computer} icon={<Monitor size={20} />} name={host} />
      </div>
      {children}
    </section>
  );
}

/** How many times `value` has changed since the first render: 0 until it does. */
function useTurns(value: string): number {
  const seen = useRef(value);
  const turns = useRef(0);
  if (seen.current !== value) {
    seen.current = value;
    turns.current += 1;
  }
  return turns.current;
}

function Node({ node, icon, name }: { node: PathNode; icon: ReactNode; name: string }) {
  const turns = useTurns(node.state);
  const marked = node.state === "ok" || node.state === "fail";
  return (
    <span className={`conn-node is-${node.state}`} aria-hidden="true">
      <span className="conn-node-icon">
        {icon}
        {/* A new mark for each result this node comes to; the one it was first drawn with is still. */}
        {marked ? (
          <span key={turns} className={`conn-node-badge${turns ? " pop-in" : ""}`}>
            {node.state === "ok"
              ? <Check size={9} strokeWidth={3.2} aria-hidden="true" />
              : <X size={9} strokeWidth={3.2} aria-hidden="true" />}
          </span>
        ) : null}
      </span>
      <b>{name}</b>
      <Swap as="small" on={node.says ?? node.note}>{node.note}</Swap>
    </span>
  );
}
