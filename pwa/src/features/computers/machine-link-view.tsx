import { Server } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import type { MachineSummary } from "../../lib/protocol/machine-link";
import { SetAction, SetGroup, SetItem, SetTag, Spinner } from "../../shared/ui/primitives";
import type { MachineLinks, MachineLinksView } from "./machine-link";

function rowSub(machine: MachineSummary, view: MachineLinksView, pairedAs: string | undefined): { text: string; tone?: "error" } | null {
  // Once connected, a machine is listed above under its own hostname.
  if (pairedAs && pairedAs !== machine.label) return { text: t("machines.addedAs", { title: pairedAs }) };
  if (view.busy?.machineId === machine.id) return { text: t(`machines.${view.busy.step}`) };
  if (view.failure?.machineId === machine.id) return { text: t(`machines.err.${view.failure.code}`), tone: "error" };
  if (machine.state !== "available") return { text: t(`machines.state.${machine.state}`) };
  return null;
}

/**
 * Machines the connected computer reaches, under the paired computers. A
 * machine already in this device's catalog is tagged instead of offered.
 * Renders nothing unless the computer advertises `link_machine` and has any.
 */
export function MachineLinkSection({ links, enabled, hostId, hostTitle, pairedTitles }: {
  links: MachineLinks;
  enabled: boolean;
  hostId: string | null;
  hostTitle: string;
  /** Title of each computer in this device's catalog, by daemon. */
  pairedTitles: ReadonlyMap<string, string>;
}) {
  const view = useSyncExternalStore(links.subscribe, links.view, links.view);
  useEffect(() => {
    void links.refresh();
  }, [links, enabled, hostId]);
  if (!enabled || !view.machines.length) return null;
  return (
    <SetGroup className="machine-set" icons label={t("machines.title", { host: hostTitle })} note={t("machines.note")}>
      {view.machines.map(machine => {
        const busy = view.busy?.machineId === machine.id;
        const pairedAs = machine.daemonId ? pairedTitles.get(machine.daemonId) : undefined;
        const added = pairedAs !== undefined;
        const sub = rowSub(machine, view, pairedAs);
        return (
          <SetItem key={machine.id} className="machine-item"
            leading={<span className="set-icon" aria-hidden="true"><Server size={17} /></span>}
            label={machine.label || machine.id} sub={sub?.text} subTone={sub?.tone}
            trailing={busy
              ? <><Spinner /><SetAction className="machine-cancel" onClick={links.cancel}>{t("machines.cancel")}</SetAction></>
              : added ? <SetTag tone="ok">{t("machines.added")}</SetTag>
              : machine.state === "available"
                ? <SetAction className="machine-add" disabled={view.busy !== null} onClick={() => void links.link(machine.id)}>{t("machines.add")}</SetAction>
                : null} />
        );
      })}
    </SetGroup>
  );
}
