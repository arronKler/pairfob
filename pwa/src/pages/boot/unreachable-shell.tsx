import { MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { formatDeviceAge } from "../../lib/ui-model";
import { beginAddComputer, forgetComputer, resumeComputer } from "../../features/computers/actions";
import { computers, credential } from "../../features/computers/catalog-store";
import { unreachableHop } from "../../features/connection/connection-path";
import { connectFailure, setRetryingUnreachable } from "../../features/connection/connection-store";
import { MenuChoice, showActionSheet } from "../../shared/ui/overlay";
import { Button, StatusDot } from "../../shared/ui/primitives";
import { CommandLine } from "../../features/dashboard/components/herd-empty";
import { ConnectionPathCard } from "./connection-path-card";

/** Automatic retries while the page is up; each is a read-only reconnect. */
export const AUTO_RETRY_S = 15;

/** The single paired computer; the page only exists when there is exactly one. */
function target() {
  return credential() ?? computers()[0] ?? null;
}

/** Retry from this page: it stays up (spinning) while the attempt runs. */
export function retryUnreachable(): void {
  const pair = target();
  if (!pair) return;
  setRetryingUnreachable(true);
  void resumeComputer(pair);
}

function openUnreachableSheet(name: string, line: string): void {
  const pair = target();
  showActionSheet(t("host.sheetTitle"), (modal) => (
    <>
      <MenuChoice modal={modal} icon={<RefreshCw size={18} aria-hidden="true" />} title={t("host.retry")} action={retryUnreachable} />
      <MenuChoice modal={modal} icon={<Plus size={18} aria-hidden="true" />} title={t("host.add")} action={beginAddComputer} />
      {pair ? (
        <MenuChoice modal={modal} danger icon={<Trash2 size={18} aria-hidden="true" />} title={t("unreach.forget")}
          action={() => void forgetComputer(pair.daemonId)} />
      ) : null}
    </>
  ), { subtitle: `${name} · ${line}` });
}

/**
 * The only paired computer could not be reached. The same frame as the list —
 * header, then the route with the broken hop, then only the steps that help on
 * that side — and a retry at thumb height that also runs by itself.
 */
export function UnreachableShell({ retrying = false }: { retrying?: boolean }) {
  const pair = target();
  const name = pair ? computerTitle(pair) : t("boot.computer");
  const hop = unreachableHop(connectFailure()) ?? "computer";
  const relay = hop === "relay";
  const line = relay ? t("unreach.lineRelay") : t("unreach.lineComputer", { when: formatDeviceAge(pair?.lastSeen) });
  const [left, setLeft] = useState(AUTO_RETRY_S);
  // Count down while idle; the retry itself runs from an effect, never from a
  // state updater (which React may call twice).
  useEffect(() => {
    if (retrying) return;
    setLeft(AUTO_RETRY_S);
    const timer = window.setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [retrying]);
  useEffect(() => {
    if (!retrying && left === 0) retryUnreachable();
  }, [left, retrying]);
  const node = (state: "ok" | "fail" | "idle", note: string) => ({ state, note });
  const failNote = retrying ? t("path.retrying") : relay ? t("path.unreachable") : t("path.offline");
  const steps = relay
    ? [
        { title: t("unreach.network"), detail: t("unreach.networkDetail") },
        { title: t("unreach.vpn"), detail: t("unreach.vpnDetail") },
      ]
    : [
        { title: t("unreach.wake"), detail: t("unreach.wakeDetail") },
        { title: t("unreach.status"), command: "pairfob service status" },
        { title: t("unreach.restart"), command: "pairfob service restart" },
      ];
  return (
    <div className="page herd-page unreachable-shell">
      <h1 className="sr-only">{t("tabs.panes")}</h1>
      <header className="herd-head">
        <div className="herd-head-row">
          <Button className="host-title is-off" aria-haspopup="dialog" aria-label={t("host.aria", { host: name, status: line })}
            onClick={() => openUnreachableSheet(name, line)}>
            <StatusDot tone="off" />
            <span className="host-title-text">
              <span className="host-title-name">{name}<MoreHorizontal size={16} aria-hidden="true" /></span>
              <span className="host-title-line">{line}</span>
            </span>
          </Button>
        </div>
      </header>
      <ConnectionPathCard host={name}
        phone={node("ok", relay ? t("path.phoneOnline") : t("path.phoneOk"))}
        link1={relay ? "fail" : "ok"}
        relay={relay ? node("fail", failNote) : node("ok", t("path.relayOk"))}
        link2={relay ? "idle" : "fail"}
        computer={relay ? node("idle", t("path.unknown")) : node("fail", failNote)}>
        <p className="conn-path-note">{relay ? t("unreach.noteRelay") : t("unreach.noteComputer", { host: name })}</p>
      </ConnectionPathCard>
      <section className="conn-steps" aria-labelledby="conn-steps-title">
        <h2 id="conn-steps-title" className="herd-empty-recent-label">{relay ? t("unreach.onPhone") : t("unreach.onComputer", { host: name })}</h2>
        <ol className="herd-group-body conn-step-list">
          {steps.map((step, index) => (
            <li key={step.title} className="conn-step">
              <span className="conn-step-n" aria-hidden="true">{index + 1}</span>
              <div className="conn-step-body">
                <b>{step.title}</b>
                {"command" in step && step.command ? <CommandLine command={step.command} /> : <small>{step.detail}</small>}
              </div>
            </li>
          ))}
        </ol>
        {relay ? <p className="herd-empty-note">{t("unreach.relayNote", { host: name })}</p> : null}
      </section>
      <div className="conn-retry-dock">
        <Button className="btn btn-primary conn-retry" disabled={retrying} onClick={retryUnreachable}>
          {retrying ? <span className="spinner conn-retry-spin" aria-hidden="true" /> : <RefreshCw size={18} aria-hidden="true" />}
          {retrying ? t("unreach.retrying") : t("unreach.retryNow")}
        </Button>
        <small className="conn-retry-note" aria-live="polite">
          {retrying ? " " : t("unreach.autoRetry", { n: String(left) })}
          {retrying ? null : <>{" · "}<Button className="text-link conn-retry-add" onClick={beginAddComputer}>{t("unreach.add")}</Button></>}
        </small>
      </div>
    </div>
  );
}
