import { useState, useSyncExternalStore, type ReactNode } from "react";
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
import { updateInProgress } from "../../lib/daemon-update-status";
import { legacyBuild } from "../../lib/daemon-version";
import { askConfirm } from "../../shared/ui/overlay/basic-dialogs";
import { t } from "../../lib/i18n";
import { currentDaemonId, liveSession } from "../computers/catalog-store";
import { Button, SetNavItem, Spinner } from "../../shared/ui/primitives";
import { openSettingsSection } from "./actions";
import { PageRefresh } from "./page-refresh";

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

function laterKeyFor(view: DaemonVersion): string {
  const issue = configIncompatible(view) ? `incompatible:${view.build}` : legacyBuild(view.build) ? "legacy" : view.latest;
  return `pairfob-update-later:${currentDaemonId()}:${issue}`;
}

function phaseCopy(phase: string, build: string, target: string): string {
  switch (phase) {
    case "downloading":
      return t("update.downloading");
    case "restarting":
      return t("update.restarting");
    case "verifying":
      return t("update.verifying");
    case "complete":
      return build === target ? t("update.complete") : t("update.waitConfirm");
    case "failed":
      return t("update.failed");
    case "rolled_back":
      return t("update.rolledBack");
    default:
      return "";
  }
}

function UpdateCommand() {
  const [copy, setCopy] = useState<"ready" | "copied" | "failed">("ready");
  const label = t(copy === "ready" ? "update.copyCommand" : copy === "copied" ? "update.copied" : "update.copyManual");
  return (
    <div className="command-line">
      <code>pairfob update</code>
      <Button
        className="set-action command-copy"
        onClick={() => {
          void navigator.clipboard
            .writeText("pairfob update")
            .then(() => {
              setCopy("copied");
            })
            .catch(() => {
              setCopy("failed");
            });
        }}
      >{label}</Button>
    </div>
  );
}

/** `inline` sits inside the computer page's card; the picker footer keeps its own card. */
export function ManualUpdateHelp({ inline = false }: { inline?: boolean }) {
  return (
    <details className={inline ? "set-item-block daemon-update-help" : "set-card daemon-update-help"}>
      <summary>{t("update.helpTitle")}</summary>
      <p className="set-note">{t("update.helpBody")}</p>
      <UpdateCommand />
    </details>
  );
}

function feedbackCopy(view: DaemonVersion): { text: string; tone?: "error" | "warn" | "ok" } {
  const checking = daemonReleaseCheckState() === "checking";
  if (configIncompatible(view)) return { text: t("update.incompatibleNote"), tone: "warn" };
  if (checking) return { text: t("update.querying") };
  if (view.error || daemonReleaseCheckState() === "error") return { text: t("update.checkFailed"), tone: "error" };
  if (legacyBuild(view.build)) return { text: t("update.needManual"), tone: "warn" };
  if (needsDaemonUpdate(view)) return { text: t("update.newVersion", { version: view.latest }), tone: "warn" };
  if (daemonReleaseCheckState() === "success") {
    return { text: view.build === view.latest ? t("update.latest") : t("update.noAuto"), tone: "ok" };
  }
  return { text: t("update.checkHint") };
}

function CompactBody({ view, laterKey, onHide }: { view: DaemonVersion; laterKey: string; onHide: () => void }) {
  const note = configIncompatible(view) ? t("update.incompatibleNote")
    : legacyBuild(view.build) ? t("update.legacyNote") : `${view.build} → ${view.latest}`;
  return (
    <section className="set-card daemon-update">
      <div className="set-row set-row-stack">
        <strong>{updateTitle(view)}</strong>
        <p className="set-note">{note}</p>
        <Button
          className="btn btn-small"
          onClick={showDaemonUpdate}
        >{t(configIncompatible(view) ? "update.viewCompatibility" : "update.view")}</Button>
        <Button
          className="btn btn-small btn-ghost"
          onClick={() => {
            try {
              localStorage.setItem(laterKey, String(Date.now()));
            } catch {
              /* unavailable storage */
            }
            onHide();
          }}
        >{t("update.later")}</Button>
      </div>
    </section>
  );
}

function DetailedBody({ view }: { view: DaemonVersion }) {
  const checking = daemonReleaseCheckState() === "checking";
  const old = legacyBuild(view.build) || view.incompatible;
  const status = view.status;
  const feedback = feedbackCopy(view);
  const showFeedback = view.checkedManually || needsDaemonUpdate(view);
  const phase = status && status.phase !== "idle" ? status.phase : null;
  const detail = showFeedback || phase || view.rejected || view.uncertain || needsDaemonUpdate(view);
  return (
    <div className="daemon-update">
      <div className="set-item daemon-update-version-row">
        <span className="set-item-text daemon-update-version">
          <span className="set-item-label">{t("update.computerVersion")}</span>
          <code className="set-item-sub">{legacyBuild(view.build) ? t("update.versionUnknown") : view.build}</code>
        </span>
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
          {checking ? <Spinner /> : null}{t(checking ? "update.checking" : "update.check")}
        </Button>
      </div>
      {detail ? (
        <div className="set-item-block daemon-update-detail">
          {showFeedback ? (
            <p className="daemon-update-feedback" role="status" aria-live="polite" {...(feedback.tone ? { "data-tone": feedback.tone } : {})}>
              {feedback.text}
            </p>
          ) : null}
          {phase ? (
            <p className="daemon-update-feedback" role="status"
              {...(phase === "failed" || phase === "rolled_back" ? { "data-tone": "error" } : {})}>
              {phaseCopy(phase, view.build, status!.target)}
            </p>
          ) : null}
          {view.rejected ? <p className="daemon-update-feedback">{t("update.rejected")}</p> : null}
          {view.uncertain ? <p className="daemon-update-feedback">{t("update.uncertain")}</p> : null}
          {needsDaemonUpdate(view) ? (
            <>
              {status?.available && !old ? (
                <Button
                  className="btn btn-primary"
                  disabled={!!view.requesting || !!view.uncertain || updateInProgress(status) || !liveSession()?.isConnected()}
                  onClick={() => {
                    const session = liveSession();
                    void askConfirm({ title: t("confirm.updateTitle"), message: t("confirm.updateEffect"),
                      confirmLabel: t("update.now"), tone: "primary" }).then((yes) => {
                      if (yes && session === liveSession()) void startDaemonUpdate();
                    });
                  }}
                >{t("update.now")}</Button>
              ) : null}
              {phase ? (
                <Button className="set-action" onClick={() => void refreshDaemonUpdate()}>{t("update.refresh")}</Button>
              ) : null}
              {configIncompatible(view) ? <PageRefresh key={currentDaemonId()} /> : <UpdateCommand />}
            </>
          ) : null}
        </div>
      ) : null}
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
  const laterKey = view ? laterKeyFor(view) : "";
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
      data-react-daemon-update={currentDaemonId() || ""}
      data-react-daemon-detailed={detailed ? "true" : "false"}
      data-detailed={detailed ? "true" : "false"}
      hidden={!inner}
    >
      {inner}
    </div>
  );
}
