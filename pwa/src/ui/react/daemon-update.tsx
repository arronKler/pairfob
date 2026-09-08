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
} from "../../daemon-update";
import { updateInProgress } from "../../lib/daemon-update-status";
import { legacyBuild } from "../../lib/daemon-version";
import { askConfirm } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { adoptScreen } from "../../compose-drafts";
import { render } from "../../paint";
import { state } from "../../state";
import { Button, Spinner } from "./chrome";

function laterDismissed(key: string): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(key)) < 86400000;
  } catch {
    return false;
  }
}

function laterKeyFor(view: DaemonVersion): string {
  return `pairfob-update-later:${state.credential?.daemonId}:${legacyBuild(view.build) ? "legacy" : view.latest}`;
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
    <>
      <code>pairfob update</code>
      <Button
        className="btn btn-small"
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
    </>
  );
}

export function ManualUpdateHelp() {
  return (
    <details className="set-card">
      <summary>{t("update.helpTitle")}</summary>
      <p className="set-note">{t("update.helpBody")}</p>
      <UpdateCommand />
    </details>
  );
}

function feedbackCopy(view: DaemonVersion): { text: string; tone?: "error" | "warn" | "ok" } {
  const checking = daemonReleaseCheckState() === "checking";
  const old = legacyBuild(view.build) || view.incompatible;
  if (checking) return { text: t("update.querying") };
  if (view.error || daemonReleaseCheckState() === "error") return { text: t("update.checkFailed"), tone: "error" };
  if (old) return { text: t("update.needManual"), tone: "warn" };
  if (needsDaemonUpdate(view)) return { text: t("update.newVersion", { version: view.latest }), tone: "warn" };
  if (daemonReleaseCheckState() === "success") {
    return { text: view.build === view.latest ? t("update.latest") : t("update.noAuto"), tone: "ok" };
  }
  return { text: t("update.checkHint") };
}

function CompactBody({ view, laterKey, onHide }: { view: DaemonVersion; laterKey: string; onHide: () => void }) {
  const old = legacyBuild(view.build) || view.incompatible;
  return (
    <section className="set-card daemon-update">
      <div className="set-row set-row-stack">
        <strong>{old ? t("update.legacyTitle") : t("update.availableTitle")}</strong>
        <p className="set-note">{old ? t("update.legacyNote") : `${view.build} → ${view.latest}`}</p>
        <Button
          className="btn btn-small"
          onClick={() => {
            adoptScreen("settings");
            render();
            document.querySelector<HTMLElement>("[data-react-daemon-detailed='true'], [data-detailed='true']")
              ?.scrollIntoView({ block: "nearest" });
            void checkDaemonRelease();
            void refreshDaemonUpdate();
          }}
        >{t("update.view")}</Button>
        <Button
          className="btn btn-small btn-ghost"
          onClick={() => {
            try {
              localStorage.setItem(laterKey, String(Date.now()));
            } catch {
              /* unavailable storage */
            }
            onHide();
            render();
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
  return (
    <section className="daemon-update daemon-update-footer">
      <div className="daemon-update-content">
        <div className="daemon-update-version-row">
          <div className="daemon-update-version">
            <span>{t("update.computerVersion")}</span>
            <code>{legacyBuild(view.build) ? t("update.versionUnknown") : view.build}</code>
          </div>
          <Button
            className="btn daemon-update-check"
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
        {showFeedback ? (
          <p className="daemon-update-feedback" role="status" aria-live="polite" {...(feedback.tone ? { "data-tone": feedback.tone } : {})}>
            {feedback.text}
          </p>
        ) : null}
        {status && status.phase !== "idle" ? (
          <p
            className="daemon-update-feedback"
            role="status"
            {...(status.phase === "failed" || status.phase === "rolled_back" ? { "data-tone": "error" } : {})}
          >
            {phaseCopy(status.phase, view.build, status.target)}
          </p>
        ) : null}
        {view.rejected ? <p className="set-note">{t("update.rejected")}</p> : null}
        {view.uncertain ? <p className="set-note">{t("update.uncertain")}</p> : null}
        {needsDaemonUpdate(view) ? (
          <>
            {status?.available && !old ? (
              <Button
                className="btn btn-small btn-primary"
                disabled={!!view.requesting || !!view.uncertain || updateInProgress(status) || !state.live?.isConnected()}
                onClick={() => {
                  const session = state.live;
                  void askConfirm(t("update.confirm")).then((yes) => {
                    if (yes && session === state.live) void startDaemonUpdate();
                  });
                }}
              >{t("update.now")}</Button>
            ) : null}
            {status && status.phase !== "idle" ? (
              <Button className="btn btn-small btn-ghost" onClick={() => void refreshDaemonUpdate()}>{t("update.refresh")}</Button>
            ) : null}
            <UpdateCommand />
          </>
        ) : null}
      </div>
    </section>
  );
}

export function DaemonUpdate({ compact = false }: { compact?: boolean }) {
  useSyncExternalStore(subscribeDaemonUpdates, daemonUpdateRevision);
  const detailed = !compact;
  const [hiddenKey, setHiddenKey] = useState("");
  const view = daemonVersion();
  const laterKey = view ? laterKeyFor(view) : "";
  let inner: ReactNode = null;
  if (!view) {
    inner = detailed ? <ManualUpdateHelp /> : null;
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
      data-react-daemon-update={state.credential?.daemonId || ""}
      data-react-daemon-detailed={detailed ? "true" : "false"}
      data-detailed={detailed ? "true" : "false"}
      hidden={!inner}
    >
      {inner}
    </div>
  );
}
