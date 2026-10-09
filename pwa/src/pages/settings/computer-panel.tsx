import { Monitor } from "lucide-react";
import type { ReactNode } from "react";
import type { HerdStatus } from "../../features/connection/herd-status";
import { settingsNetworkP2PFail, settingsNetworkPath, type SettingsNetworkInput } from "../../features/settings/model";
import { ThisDeviceIcon } from "../../features/settings/this-device";
import { t } from "../../lib/i18n";
import { Button, Chevron } from "../../shared/ui/primitives";

/**
 * The computer panel shared by the overview and the computer page: the
 * computer's name over a live link from this device to it. The line itself is
 * the status — solid for a direct P2P path, dashed through the relay, broken
 * while offline, quiet while the first read is pending — and the path with its
 * round trip sits on the line. Both pages place the panel at the same height,
 * so opening the computer page keeps it still while the page content moves.
 */

export type LinkWire = "p2p" | "relay" | "off" | "wait";
export type LinkState = { wire: LinkWire; chip: string; note: string | null; noteTone: "warn" | "muted" };

/**
 * Project the published session state onto the link. The wire follows the
 * transport (is this device talking to the computer, and how); what the
 * computer's runtime reports — Herdr unverified, still reading — and a failed
 * P2P attempt read as a note under it.
 */
export function linkState(status: HerdStatus, network: SettingsNetworkInput, connected: boolean): LinkState {
  if (!connected) {
    return status.tone === "pending"
      ? { wire: "wait", chip: status.text, note: null, noteTone: "muted" }
      : { wire: "off", chip: t("set.linkOff"), note: status.text, noteTone: "warn" };
  }
  const fail = settingsNetworkP2PFail(network);
  const runtime = status.tone === "live" ? null : status.text;
  return {
    wire: network.sessionTransport === "p2p" ? "p2p" : "relay",
    chip: settingsNetworkPath(network),
    note: fail || runtime,
    noteTone: fail || status.tone === "warn" || status.tone === "off" ? "warn" : "muted",
  };
}

function Link({ link }: { link: LinkState }) {
  return <span className="cp-link" role="img" aria-label={t("set.linkAria", { path: link.chip })}>
    <span className="cp-node"><span className="cp-node-mark"><ThisDeviceIcon size={20} /></span>{t("set.linkPhone")}</span>
    <span className={`cp-wire is-${link.wire}`}><span className="cp-chip">{link.chip}</span></span>
    <span className="cp-node is-end"><span className="cp-node-mark"><Monitor size={20} aria-hidden="true" /></span>{t("set.linkComputer")}</span>
  </span>;
}

/** `onOpen` makes the head a button into the computer page; rows below it (update, switch) arrive as children. */
export function ComputerPanel({ name, link, onOpen, children }: {
  name: string; link: LinkState; onOpen?: () => void; children?: ReactNode;
}) {
  const body = <>
    <span className="cp-head"><span className="cp-name">{name}</span>{onOpen ? <Chevron className="chev set-chev" /> : null}</span>
    <Link link={link} />
    {link.note ? <span className={`cp-note${link.noteTone === "warn" ? " is-warn" : ""}`}>{link.note}</span> : null}
  </>;
  return <section className="set-group computer-panel">
    <div className="set-card set-list">
      {onOpen ? <Button className="cp-main" onClick={onOpen}>{body}</Button> : <div className="cp-main">{body}</div>}
      {children}
    </div>
  </section>;
}
