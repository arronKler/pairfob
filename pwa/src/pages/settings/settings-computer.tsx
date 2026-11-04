import { Check, Download } from "lucide-react";
import type { ConnectionRecord } from "../../features/connection/connection-store";
import type { RuntimeRecord } from "../../features/connection/runtime-store";
import { revokeSelf } from "../../features/operations/controller";
import { selectNetworkMode } from "../../features/settings/actions";
import { exportConnectionDiagnostics } from "../../features/settings/connection-diagnostics";
import { DaemonUpdate } from "../../features/settings/daemon-update-view";
import { t } from "../../lib/i18n";
import { NETWORK_MODE_OPTIONS, type NetworkMode } from "../../lib/network-mode";
import type { DomainView } from "../../shared/model/domain-store";
import { Button, SegmentedControl, SetAction, SetGroup, SetItem } from "../../shared/ui/primitives";
import { ComputerPanel, type LinkState } from "./computer-panel";
import { DevicesGroup } from "./settings-devices";

/**
 * The computer page behind the overview's panel: the same panel, the network
 * route, the computer's version and update, its paired devices, diagnostics,
 * and unpairing this phone from it — everything that belongs to this computer.
 */

const ROUTE_COPY: Record<NetworkMode, { title: "set.routeAuto" | "set.routeP2P" | "set.routeRelay"; desc: "set.routeAutoDesc" | "set.routeP2PDesc" | "set.routeRelayDesc" }> = {
  auto: { title: "set.routeAuto", desc: "set.routeAutoDesc" },
  p2p: { title: "set.routeP2P", desc: "set.routeP2PDesc" },
  relay: { title: "set.routeRelay", desc: "set.routeRelayDesc" },
};

/** Three single-choice rows; choosing P2P again retries the direct path now. */
function RouteGroup({ connection }: { connection: ConnectionRecord }) {
  return <SetGroup className="route-group" label={t("set.routeGroup")} note={connection.p2pEnabled ? null : t("settings.networkP2POff")}>
    <SegmentedControl className="set-radios" activation="manual" aria-label={t("settings.networkAria")} aria-busy={connection.transportSwitching || undefined}>
      {NETWORK_MODE_OPTIONS.map(id => {
        const selected = connection.networkMode === id;
        return <Button key={id} role="radio" aria-checked={selected} className="set-item set-radio"
          disabled={id === "p2p" && !connection.p2pEnabled} tabIndex={selected ? 0 : -1} onClick={() => void selectNetworkMode(id)}>
          <span className="set-item-text">
            <span className="set-item-label">{t(ROUTE_COPY[id].title)}{id === "auto" ? <span className="set-tag">{t("set.routeRecommended")}</span> : null}</span>
            <span className="set-item-sub">{t(ROUTE_COPY[id].desc)}</span>
          </span>
          <Check className="set-radio-mark" size={20} aria-hidden="true" />
        </Button>;
      })}
    </SegmentedControl>
  </SetGroup>;
}

export function ComputerSection({ name, link, connection, runtime, connected, onRename }: {
  name: string; link: LinkState; connection: ConnectionRecord; runtime: DomainView<RuntimeRecord>; connected: boolean;
  onRename?: () => void;
}) {
  return <>
    <ComputerPanel name={name} link={link} onRename={onRename} />
    <RouteGroup connection={connection} />
    <SetGroup className="daemon-group" id="settings-daemon" label={t("set.computerGroup")}><DaemonUpdate /></SetGroup>
    <DevicesGroup runtime={runtime} connected={connected} />
    <SetGroup label={t("set.diagGroup")}>
      <SetItem label={t("settings.exportConnectionDiagnostics")} sub={t("settings.connectionDiagnosticsLocal")}
        trailing={<SetAction onClick={exportConnectionDiagnostics}><Download size={14} aria-hidden="true" />{t("set.export")}</SetAction>} />
    </SetGroup>
    <SetGroup note={t("settings.unpairNote")}>
      <Button className="set-item set-danger" onClick={() => void revokeSelf()}>{t("settings.unpair")}</Button>
    </SetGroup>
  </>;
}
