import { useEffect, useState } from "react";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { resumeComputer } from "../../features/computers/actions";
import { computers, credential } from "../../features/computers/catalog-store";
import { connectionWait, SLOW_CONNECT_MS, type PathHop } from "../../features/connection/connection-path";
import { phase as currentPhase, retryingUnreachable } from "../../features/connection/connection-store";
import { HerdSkeleton } from "../../features/dashboard/components/herd-skeleton";
import { MenuChoice, showActionSheet } from "../../shared/ui/overlay";
import { Button, StatusDot } from "../../shared/ui/primitives";
import type { PairResult } from "../../lib/protocol/client";
import { ConnectionPathCard } from "./connection-path-card";
import { UnreachableShell } from "./unreachable-shell";
import { useConnection } from "../../features/connection/hooks";
import { StorageRecovery } from "./storage-recovery";

/**
 * The phone's boot and reconnect frame. It is the session list's own frame —
 * the same header box, placeholder rows and (from the app) tab bar — so going
 * live only fills it in: nothing moves. The computer name appears as soon as
 * the stored credential is read; until then a placeholder bar holds its place.
 *
 * A connect that takes longer than `SLOW_CONNECT_MS` says where it is waiting
 * (the connection path) without turning into an error: it is still trying.
 * A retry started from the "cannot reach" page keeps that page up instead.
 */
export function BootShell() {
  const { bootStorageBlocked } = useConnection();
  if (bootStorageBlocked) return <div className="page herd-page boot-shell"><StorageRecovery /></div>;
  const reading = currentPhase() === "boot";
  return !reading && retryingUnreachable() ? <UnreachableShell retrying /> : <BootFrame reading={reading} />;
}

function BootFrame({ reading }: { reading: boolean }) {
  const current = reading ? null : credential();
  const name = current ? computerTitle(current) : "";
  const slow = useSlowConnect(!reading);
  const line = reading ? t("boot.reading")
    : slow ? t(slow.hop === "relay" ? "slow.lineRelay" : "slow.lineComputer", { n: String(slow.seconds) })
    : t("boot.connectingLine");
  return (
    <div className="page herd-page boot-shell">
      <h1 className="sr-only">{t("tabs.sessions")}</h1>
      <header className="herd-head">
        <div className="herd-head-row">
          <div className={`host-title ${slow ? "is-warn" : "is-pending"}`} role="status">
            <StatusDot tone={slow ? "warn" : "pending"} />
            <span className="host-title-text">
              {name
                ? <span className="host-title-name">{name}</span>
                : <span className="herd-sk boot-shell-name" aria-hidden="true" />}
              <span className="host-title-line">{line}</span>
            </span>
          </div>
        </div>
      </header>
      {slow && current ? <SlowPanel pair={current} name={name} hop={slow.hop} seconds={slow.seconds} /> : null}
      <HerdSkeleton />
    </div>
  );
}

/** The wait so far, once it is slow; re-read every second from the recorded stages. */
function useSlowConnect(active: boolean): { hop: PathHop; seconds: number } | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const wait = connectionWait();
  if (!wait || now - wait.since < SLOW_CONNECT_MS) return null;
  return { hop: wait.hop, seconds: Math.floor((now - wait.since) / 1000) };
}

function SlowPanel({ pair, name, hop, seconds }: { pair: PairResult; name: string; hop: PathHop; seconds: number }) {
  const relay = hop === "relay";
  const others = computers().filter((item) => item.daemonId !== pair.daemonId);
  const node = (state: "ok" | "wait" | "idle", note: string) => ({ state, note });
  return (
    <ConnectionPathCard host={name}
      phone={node("ok", t("path.phoneOk"))}
      link1={relay ? "wait" : "ok"}
      relay={relay ? node("wait", t("path.relayWait", { n: String(seconds) })) : node("ok", t("path.relayOk"))}
      link2={relay ? "idle" : "wait"}
      computer={relay ? node("idle", t("path.idle")) : node("wait", t("path.waitingSeconds", { n: String(seconds) }))}>
      <p className="conn-path-note">{relay ? t("slow.noteRelay") : t("slow.noteComputer")}</p>
      <div className="conn-path-actions">
        {/* A newer attempt supersedes the one in flight; nothing is replayed. */}
        <Button className="text-link" onClick={() => void resumeComputer(pair)}>{t("slow.reconnect")}</Button>
        {others.length ? <>
          <span aria-hidden="true">·</span>
          <Button className="text-link" onClick={() => openSwitchSheet(others)}>{t("slow.switch")}</Button>
        </> : null}
      </div>
    </ConnectionPathCard>
  );
}

function openSwitchSheet(others: readonly PairResult[]): void {
  showActionSheet(t("slow.switch"), (modal) => (
    <>
      {others.map((pair) => (
        <MenuChoice key={pair.daemonId} modal={modal} title={computerTitle(pair)} action={() => void resumeComputer(pair)} />
      ))}
    </>
  ));
}
