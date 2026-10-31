import { useEffect, useRef, useState } from "react";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { resumeComputer } from "../../features/computers/actions";
import { useComputers, useCredential } from "../../features/computers/hooks";
import { connectionWait, SLOW_CONNECT_MS, type PathHop } from "../../features/connection/connection-path";
import { ReadingFrame } from "./reading-frame";
import { HerdSkeleton } from "../../features/dashboard/components/herd-skeleton";
import { MenuChoice, showActionSheet } from "../../shared/ui/overlay";
import { Button, Fold, StatusDot } from "../../shared/ui/primitives";
import { usePresence } from "../../shared/react/use-presence";
import { MOTION_MS } from "../../shared/ui/dom/motion";
import type { PairResult } from "../../lib/protocol/client";
import { ConnectionPathCard } from "./connection-path-card";
import { UnreachableShell } from "./unreachable-shell";
import { useBootBlocked, useConnectionPhase, useRetryingUnreachable } from "../../features/connection/hooks";
import { BootRecovery } from "./boot-recovery";

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
  const bootBlocked = useBootBlocked();
  const reading = useConnectionPhase() === "boot";
  const retrying = useRetryingUnreachable();
  if (bootBlocked) return <div className="page herd-page boot-shell"><BootRecovery block={bootBlocked} /></div>;
  if (reading) return <ReadingFrame />;
  return retrying ? <UnreachableShell retrying /> : <BootFrame />;
}

function BootFrame() {
  const current = useCredential();
  const name = current ? computerTitle(current) : "";
  const slow = useSlowConnect();
  const showing = !!slow && !!current;
  // What the card last said stays in it while it shuts.
  const shown = useRef<{ pair: PairResult; name: string; hop: PathHop; seconds: number } | null>(null);
  if (slow && current) shown.current = { pair: current, name, hop: slow.hop, seconds: slow.seconds };
  const card = usePresence(showing, MOTION_MS.panel);
  const line = slow
    ? t(slow.hop === "relay" ? "slow.lineRelay" : "slow.lineComputer", { n: String(slow.seconds) })
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
      {/* The card opens under the header and moves the rows down with it. Its
          place is there from the start, shut, so it opens because the wait
          became slow and not because the frame was drawn. */}
      <Fold open={showing}>
        {card.mounted && shown.current ? <SlowPanel {...shown.current} /> : null}
      </Fold>
      <HerdSkeleton />
    </div>
  );
}

/** The wait so far, once it is slow; re-read every second from the recorded stages. */
function useSlowConnect(): { hop: PathHop; seconds: number } | null {
  // The interval only repaints; each render reads the clock, so a new connect
  // attempt is never measured against a time kept from an earlier one.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((count) => count + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const now = Date.now();
  const wait = connectionWait();
  if (!wait || now - wait.since < SLOW_CONNECT_MS) return null;
  return { hop: wait.hop, seconds: Math.floor((now - wait.since) / 1000) };
}

function SlowPanel({ pair, name, hop, seconds }: { pair: PairResult; name: string; hop: PathHop; seconds: number }) {
  const relay = hop === "relay";
  const others = useComputers().computers.filter((item) => item.daemonId !== pair.daemonId);
  const node = (state: "ok" | "wait" | "idle", note: string) => ({ state, note });
  // A waiting note counts seconds; it is one note for as long as the hop waits.
  const waiting = (note: string) => ({ ...node("wait", note), says: "wait" });
  return (
    <ConnectionPathCard host={name}
      phone={node("ok", t("path.phoneOk"))}
      link1={relay ? "wait" : "ok"}
      relay={relay ? waiting(t("path.relayWait", { n: String(seconds) })) : node("ok", t("path.relayOk"))}
      link2={relay ? "idle" : "wait"}
      computer={relay ? node("idle", t("path.idle")) : waiting(t("path.waitingSeconds", { n: String(seconds) }))}>
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
  ), { popover: "menu" });
}
