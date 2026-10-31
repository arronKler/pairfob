import { Check } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  checkDaemonRelease,
  daemonReleaseCheckState,
  daemonVersion,
  daemonUpdateRevision,
  needsDaemonUpdate,
  refreshDaemonUpdate,
  startDaemonUpdate,
  subscribeDaemonUpdates,
  type DaemonVersion,
} from "./daemon-update";
import { updateInProgress, type UpdateStatus } from "../../lib/daemon-update-status";
import { legacyBuild, newerRelease, sameRelease } from "../../lib/daemon-version";
import { askConfirm } from "../../shared/ui/overlay/basic-dialogs";
import { t } from "../../lib/i18n";
import { liveSession } from "../computers/catalog-store";
import { useCredential, useLiveSession } from "../computers/hooks";
import { Button, SetNavItem, Spinner } from "../../shared/ui/primitives";
import { openSettingsSection } from "./actions";
import { PageRefresh } from "./page-refresh";
import { ManualUpdate, ManualUpdateHelp, PairfobCommand } from "./daemon-update-manual";

export { ManualUpdateHelp };

function configIncompatible(view: DaemonVersion): boolean {
  // A known legacy placeholder has its own manual-upgrade guidance. Other
  // rejected configs do not establish which side of the connection is old.
  return !!view.incompatible && view.build !== "0.1.0";
}

function updateTitle(view: DaemonVersion, available: "update.availableTitle" | "set.updateAvailable" = "update.availableTitle"): string {
  if (configIncompatible(view)) return t("update.incompatibleTitle");
  return t(legacyBuild(view.build) ? "update.legacyTitle" : available);
}

function laterDismissed(key: string): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(key)) < 86400000;
  } catch {
    return false;
  }
}

function laterKeyFor(view: DaemonVersion, daemonId: string | null): string {
  const issue = configIncompatible(view) ? `incompatible:${view.build}` : legacyBuild(view.build) ? "legacy" : view.latest;
  return `pairfob-update-later:${daemonId}:${issue}`;
}

/** Whether an update is on its way: asked for, running, or sent without an answer yet. */
function updateBusy(view: DaemonVersion): boolean {
  return !!view.requesting || !!view.uncertain || updateInProgress(view.status);
}

function CompactBody({ view, laterKey, onHide }: { view: DaemonVersion; laterKey: string; onHide: () => void }) {
  const busy = updateBusy(view);
  const note = busy ? null : configIncompatible(view) ? t("update.incompatibleNote")
    : legacyBuild(view.build) ? t("update.legacyNote") : `${view.build} → ${view.latest}`;
  return (
    <section className="set-card daemon-update">
      <div className="set-row set-row-stack">
        <strong>{busy ? t("set.updating") : updateTitle(view)}</strong>
        {note ? <p className="set-note">{note}</p> : null}
        <Button
          className="btn btn-small"
          onClick={showDaemonUpdate}
        >{t(busy ? "update.viewProgress" : configIncompatible(view) ? "update.viewCompatibility" : "update.view")}</Button>
        {busy ? null : <Button
          className="btn btn-small btn-ghost"
          onClick={() => {
            try {
              localStorage.setItem(laterKey, String(Date.now()));
            } catch {
              /* unavailable storage */
            }
            onHide();
          }}
        >{t("update.later")}</Button>}
      </div>
    </section>
  );
}

/**
 * What the card's middle says, one at a time. Each stage is a sentence and at
 * most one action; the order is which fact wins when several hold at once.
 */
type Stage = "incompatible" | "busy" | "uncertain" | "waiting" | "done" | "current" | "failed" | "manual" | "available";

function updateStage(view: DaemonVersion): Stage {
  const status = view.status;
  if (configIncompatible(view)) return "incompatible";
  if (view.requesting || updateInProgress(status)) return "busy";
  if (view.uncertain) return "uncertain";
  // A completed record can survive a later CLI update. The running build is
  // authoritative; an older target must not look like a pending restart.
  if (status?.phase === "complete" && status.target) {
    const targetRunning = sameRelease(view.build, status.target);
    if (!targetRunning && !newerRelease(view.build, status.target)) return "waiting";
    if (targetRunning && view.watched) return "done";
  }
  if (!needsDaemonUpdate(view)) return "current";
  if (status?.phase === "failed" || status?.phase === "rolled_back") return "failed";
  if (legacyBuild(view.build) || view.noRemote || status?.available === false) return "manual";
  return "available";
}

const STEPS = [
  ["downloading", "update.stepDownload"], ["restarting", "update.stepRestart"], ["verifying", "update.stepVerify"],
] as const;

/** The three phases the computer reports, the current one turning. A request not yet answered is the first. */
function UpdateSteps({ phase }: { phase?: UpdateStatus["phase"] }) {
  const at = Math.max(0, STEPS.findIndex(([name]) => name === phase));
  return (
    <ol className="daemon-update-steps" role="status" aria-live="polite">
      {STEPS.map(([name, key], index) => {
        const state = index < at ? "done" : index === at ? "now" : "next";
        return <li key={name} data-state={state} aria-current={state === "now" ? "step" : undefined}>
          <span className="daemon-update-step-mark" aria-hidden="true">
            {state === "done" ? <Check size={14} /> : state === "now" ? <Spinner /> : null}
          </span>
          {t(key)}
        </li>;
      })}
    </ol>
  );
}

function Line({ tone, children, live = false }: { tone?: "error" | "warn" | "ok"; children: ReactNode; live?: boolean }) {
  return <p className="daemon-update-feedback" {...(tone ? { "data-tone": tone } : {})} {...(live ? { role: "status", "aria-live": "polite" as const } : {})}>{children}</p>;
}

function UpdateButton({ view, label }: { view: DaemonVersion; label: string }) {
  const live = useLiveSession();
  return (
    <Button
      className="btn btn-primary daemon-update-start"
      disabled={updateBusy(view) || !view.status?.available || !live?.isConnected()}
      onClick={() => {
        const session = liveSession();
        void askConfirm({ title: t("confirm.updateTitle"), message: t("confirm.updateEffect"),
          confirmLabel: t("update.now", { version: view.latest }), tone: "primary" }).then((yes) => {
          if (yes && session === liveSession()) void startDaemonUpdate();
        });
      }}
    >{label}</Button>
  );
}

/** What a reader's own check found, said only after they asked. */
function checkResult(view: DaemonVersion): ReactNode {
  if (!view.checkedManually) return null;
  const state = daemonReleaseCheckState();
  if (state === "checking") return null;
  if (view.error || state === "error") return <Line tone="error" live>{t("update.checkFailed")}</Line>;
  if (state !== "success") return null;
  return <Line tone="ok" live>{sameRelease(view.build, view.latest) ? <><Check size={14} aria-hidden="true" />{t("update.latest")}</> : t("update.noAuto")}</Line>;
}

function StageBody({ view, stage, daemonId }: { view: DaemonVersion; stage: Stage; daemonId: string | null }) {
  const status = view.status;
  switch (stage) {
    case "incompatible":
      return <><Line tone="warn">{t("update.incompatibleNote")}</Line><PageRefresh key={daemonId ?? ""} /></>;
    case "busy":
      return <><UpdateSteps phase={status?.phase} /><p className="set-note">{t("update.busyNote")}</p></>;
    case "uncertain":
      return <>
        <p className="daemon-update-feedback daemon-update-pending" role="status" aria-live="polite"><Spinner />{t("update.uncertain")}</p>
        <p className="set-note">{t("update.uncertainNote")}</p>
      </>;
    case "waiting":
      return <Line live>{t("update.waitConfirm", { version: status!.target, current: view.build || t("update.versionUnknown") })}</Line>;
    case "done":
      return <Line tone="ok" live><Check size={14} aria-hidden="true" />{t("update.complete", { version: view.build })}</Line>;
    case "current":
      return checkResult(view);
    case "failed":
      return <>
        <Line tone="error" live>{status?.phase === "rolled_back" ? t("update.rolledBack", { version: view.build }) : t("update.failed")}</Line>
        {status?.available ? <UpdateButton view={view} label={t("update.retry")} /> : null}
      </>;
    case "manual":
      return <><Line tone="warn">{t("update.needManual")}</Line><PairfobCommand /></>;
    case "available":
      return <>
        {view.error && view.checkedManually ? <Line tone="error" live>{t("update.checkFailed")}</Line> : null}
        {view.rejected ? <Line tone="error" live>{t("update.rejected")}</Line> : null}
        {view.unconfirmed ? <Line tone="warn" live>{t("update.unconfirmed")}</Line> : null}
        <p className="daemon-update-diff"><span>{view.build}</span><span aria-hidden="true">→</span><strong>{view.latest}</strong></p>
        <p className="set-note">{t("update.effect")}</p>
        <UpdateButton view={view} label={t("update.now", { version: view.latest })} />
      </>;
  }
}

function CheckButton({ view }: { view: DaemonVersion }) {
  const checking = daemonReleaseCheckState() === "checking";
  const retry = !checking && !!view.checkedManually && (view.error || daemonReleaseCheckState() === "error");
  return (
    <Button
      className="set-action daemon-update-check"
      disabled={checking}
      aria-busy={checking}
      onClick={() => {
        view.checkedManually = true;
        void (async () => {
          await checkDaemonRelease(true);
          await refreshDaemonUpdate();
        })();
      }}
    >
      {checking ? <Spinner /> : null}{t(checking ? "update.checking" : retry ? "update.retryCheck" : "update.check")}
    </Button>
  );
}

/**
 * The computer page's update card: the version row, the stage in the middle
 * and the manual commands folded at the end. The three keep their places; only
 * what they hold changes.
 */
function DetailedBody({ view }: { view: DaemonVersion }) {
  const stage = updateStage(view);
  const daemonId = useCredential()?.daemonId ?? null;
  const body = StageBody({ view, stage, daemonId });
  // A finished update is news once: leaving the page lets go of it.
  useEffect(() => () => {
    const current = daemonVersion();
    if (current && current.status?.phase === "complete") current.watched = false;
  }, []);
  return (
    <div className="daemon-update" data-stage={stage}>
      <div className="set-item daemon-update-version-row">
        <span className="set-item-text daemon-update-version">
          <span className="set-item-label">{t("update.computerVersion")}</span>
          <code className="set-item-sub">{legacyBuild(view.build) ? t("update.versionUnknown") : view.build}</code>
        </span>
        {stage === "busy" || stage === "uncertain" ? null : <CheckButton view={view} />}
      </div>
      {body ? <div className="set-item-block daemon-update-detail">{body}</div> : null}
      <ManualUpdate withPairfob={stage !== "manual" && stage !== "incompatible"} open={stage === "failed"} />
    </div>
  );
}

/**
 * Open the computer page on its update block: the overview's update row and
 * the desk rail's banner both land here, then re-read the release and status.
 */
export function showDaemonUpdate(): void {
  openSettingsSection("connection");
  requestAnimationFrame(() => {
    const group = document.getElementById("settings-daemon");
    if (!group) return;
    group.scrollIntoView({ block: "center" });
    group.classList.add("is-focused");
    globalThis.setTimeout(() => group.classList.remove("is-focused"), 1_600);
  });
  void checkDaemonRelease();
  void refreshDaemonUpdate();
}

/** The overview's one-line update row inside the computer panel; nothing while the computer is current. */
export function DaemonUpdateRow() {
  useSyncExternalStore(subscribeDaemonUpdates, daemonUpdateRevision);
  const view = daemonVersion();
  if (!view || !needsDaemonUpdate(view)) return null;
  const old = legacyBuild(view.build) || view.incompatible;
  const busy = updateInProgress(view.status);
  return <SetNavItem className="daemon-update-row" label={busy ? t("set.updating") : updateTitle(view, "set.updateAvailable")}
    value={busy || old ? undefined : view.latest} valueTone="accent" onClick={showDaemonUpdate} />;
}

export function DaemonUpdate({ compact = false }: { compact?: boolean }) {
  useSyncExternalStore(subscribeDaemonUpdates, daemonUpdateRevision);
  const detailed = !compact;
  const [hiddenKey, setHiddenKey] = useState("");
  const view = daemonVersion();
  const daemonId = useCredential()?.daemonId ?? null;
  const laterKey = view ? laterKeyFor(view, daemonId) : "";
  let inner: ReactNode = null;
  if (!view) {
    inner = detailed ? <ManualUpdateHelp inline /> : null;
  } else if (!detailed && !needsDaemonUpdate(view)) {
    inner = null;
  } else if (!detailed && (hiddenKey === laterKey || laterDismissed(laterKey))) {
    inner = null;
  } else if (!detailed) {
    inner = <CompactBody view={view} laterKey={laterKey} onHide={() => setHiddenKey(laterKey)} />;
  } else {
    inner = <DetailedBody view={view} />;
  }
  return (
    <div
      className="daemon-update-host"
      data-react-daemon-update={daemonId || ""}
      data-react-daemon-detailed={detailed ? "true" : "false"}
      data-detailed={detailed ? "true" : "false"}
      hidden={!inner}
    >
      {inner}
    </div>
  );
}
