import { Check, Copy, Lock, Monitor, RefreshCw, ShieldAlert, Wifi } from "lucide-react";
import { t } from "../../lib/i18n";
import type { DesktopQuality } from "../../lib/protocol/remote-desktop";
import { useCopied } from "../../shared/react/use-copied";
import { Button, CopyAck, Spinner } from "../../shared/ui/primitives";
import type { DesktopMode } from "./desktop-prefs";
import { RecoveryConsole } from "./recovery-console";

export type PreflightKind = "unsupported" | "relay" | "connecting" | "reconnecting" | "disconnected";

type PreflightProps = {
  kind: PreflightKind;
  hostName: string;
  connectingStep?: "p2p" | "media";
  reconnectAttempt?: number;
  maxReconnectAttempts?: number;
  mode: DesktopMode;
  quality: DesktopQuality;
  error?: string;
  onReconnect?: () => void;
  onRetryDirect?: () => void;
  onCancel?: () => void;
  onBack?: () => void;
  onOpenSettings?: () => void;
};

export function DesktopPreflight({
  kind,
  hostName,
  connectingStep = "p2p",
  reconnectAttempt = 1,
  maxReconnectAttempts = 4,
  mode,
  quality,
  error,
  onReconnect,
  onRetryDirect,
  onCancel,
  onBack,
  onOpenSettings,
}: PreflightProps) {
  const [copied, confirmCopy] = useCopied<"cmd">();
  const setupCmd = t("desktop.setupCommand");

  async function copySetupCommand() {
    try {
      await navigator.clipboard.writeText(setupCmd);
      confirmCopy("cmd");
    } catch {
      /* clipboard permission denied */
    }
  }

  if (kind === "connecting") {
    const modeLabel = mode === "control" ? t("desktop.control") : t("desktop.view");
    const qualityLabel = t(`desktop.${quality}`);
    return (
      <div className="rd-state-overlay" role="status" aria-live="polite">
        <div className="rd-state-card rd-connecting-card">
          <div className="rd-connecting-spinner">
            <Spinner />
          </div>
          <h2 className="rd-state-title rd-center">{t("desktop.connectingHost", { host: hostName })}</h2>
          <p className="rd-state-sub rd-center">
            {connectingStep === "p2p" ? t("desktop.connectingStepP2P") : t("desktop.connectingStepMedia")}
          </p>
          <div className="rd-pref-badge">
            {t("desktop.autoPrefs", { mode: modeLabel, quality: qualityLabel })}
          </div>
          {(onCancel || onBack) && (
            <div className="rd-state-actions rd-center">
              <Button className="btn btn-small" onClick={onCancel ?? onBack}>{t("desktop.cancel")}</Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kind === "reconnecting") {
    return (
      <div className="rd-state-overlay" role="status" aria-live="polite">
        <div className="rd-state-card rd-connecting-card">
          <div className="rd-connecting-spinner">
            <Spinner />
          </div>
          <h2 className="rd-state-title rd-center">{t("desktop.reconnectingHost", { host: hostName })}</h2>
          <p className="rd-state-sub rd-center">
            {t("desktop.reconnectingSub", { attempt: Math.max(1, reconnectAttempt), max: maxReconnectAttempts })}
          </p>
          <div className="rd-state-actions rd-center">
            {onReconnect && (
              <Button className="btn btn-primary btn-small" onClick={onReconnect}>{t("desktop.retryNow")}</Button>
            )}
            {(onCancel || onBack) && (
              <Button className="btn btn-small" onClick={onCancel ?? onBack}>{t("desktop.cancel")}</Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (kind === "unsupported") {
    return (
      <div className="rd-state-overlay">
        <div className="rd-state-card">
          <div className="rd-state-head">
            <div className="rd-state-icon"><Monitor size={18} aria-hidden="true" /></div>
            <div>
              <h2 className="rd-state-title">{t("desktop.preflightUnsupportedTitle")}</h2>
              <div className="rd-state-host">{hostName}</div>
            </div>
          </div>
          <p className="rd-state-sub">{t("desktop.preflightUnsupportedSub")}</p>
          <div className="rd-cmd-copy">
            <code>{setupCmd}</code>
            <Button className="rd-copy-btn" onClick={() => void copySetupCommand()}>
              <CopyAck
                state={copied ? "copied" : "idle"}
                idle={<><Copy size={13} aria-hidden="true" />{t("desktop.copy")}</>}
                copied={<><Check size={13} aria-hidden="true" />{t("desktop.copied")}</>}
              />
            </Button>
          </div>
          <div className="rd-state-actions">
            {onOpenSettings && (
              <Button className="btn btn-primary btn-small" onClick={onOpenSettings}>{t("desktop.openSettings")}</Button>
            )}
            {onBack && (
              <Button className="btn btn-small" onClick={onBack}>{t("desktop.back")}</Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (kind === "relay") {
    return (
      <div className="rd-state-overlay">
        <div className="rd-state-card">
          <div className="rd-state-head">
            <div className="rd-state-icon is-warn"><Wifi size={18} aria-hidden="true" /></div>
            <div>
              <h2 className="rd-state-title">{t("desktop.relayTitle")}</h2>
              <div className="rd-state-host">{hostName}</div>
            </div>
          </div>
          <div className="rd-link-diagram" aria-hidden="true">
            <span className="rd-ld-node">{t("desktop.thisDevice")}</span>
            <span className="rd-ld-wire is-dashed">
              <span className="rd-ld-chip">{t("desktop.relayBadge")}</span>
            </span>
            <span className="rd-ld-node">{t("desktop.hostNode")}</span>
          </div>
          <p className="rd-state-sub">{t("desktop.relaySub")}</p>
          <div className="rd-state-actions">
            {onRetryDirect && (
              <Button className="btn btn-primary btn-small" onClick={onRetryDirect}>
                <RefreshCw size={14} aria-hidden="true" />
                {t("desktop.retryDirect")}
              </Button>
            )}
            {onBack && (
              <Button className="btn btn-small" onClick={onBack}>{t("desktop.back")}</Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const hasError = Boolean(error);
  return (
    <div className="rd-state-overlay">
      <div className="rd-state-card">
        <div className="rd-state-head">
          <div className={`rd-state-icon${hasError ? " is-error" : ""}`}>
            {hasError ? <Lock size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
          </div>
          <div>
            <h2 className="rd-state-title">{hasError ? error : t("desktop.disconnectedTitle")}</h2>
            <div className="rd-state-host">{hostName}</div>
          </div>
        </div>
        {!hasError && <p className="rd-state-sub">{t("desktop.disconnectedSub")}</p>}
        <div className="rd-recovery-wrap">
          <RecoveryConsole />
        </div>
        <div className="rd-state-actions">
          {onReconnect && (
            <Button className="btn btn-primary btn-small" onClick={onReconnect}>{t("desktop.reconnect")}</Button>
          )}
          {onBack && (
            <Button className="btn btn-small" onClick={onBack}>{t("desktop.back")}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
