import { Check, Copy, Lock, Monitor, Moon, RefreshCw, ShieldAlert, Wifi } from "lucide-react";
import { t } from "../../lib/i18n";
import type { DesktopQuality } from "../../lib/protocol/remote-desktop";
import { readConsole } from "../../lib/recovery-console";
import { useCopied } from "../../shared/react/use-copied";
import { Button, CopyAck, Spinner } from "../../shared/ui/primitives";
import { useComputers } from "../computers/hooks";
import type { DesktopMode } from "./desktop-prefs";
import { parseDesktopReason, type DesktopReasonKind } from "./desktop-reason";
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
  reasonKind?: DesktopReasonKind | null;
  onReconnect?: () => void;
  onRetryDirect?: () => void;
  onCancel?: () => void;
  onBack?: () => void;
  onOpenSettings?: () => void;
};

type DisconnectedCardSpec = {
  title: string;
  sub?: string;
  tone: "" | " is-warn" | " is-error";
  icon: "lock" | "sleep" | "perm" | "monitor" | "default";
  showRecovery: boolean;
  autoExpandRecovery: boolean;
  showStatusCmd: boolean;
  reconnectLabel: string;
};

function CopyCommandBox({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rd-cmd-copy">
      <code>{command}</code>
      <Button className="rd-copy-btn" onClick={onCopy}>
        <CopyAck
          state={copied ? "copied" : "idle"}
          idle={<><Copy size={13} aria-hidden="true" />{t("desktop.copy")}</>}
          copied={<><Check size={13} aria-hidden="true" />{t("desktop.copied")}</>}
        />
      </Button>
    </div>
  );
}

function renderDisconnectedIcon(icon: DisconnectedCardSpec["icon"]) {
  if (icon === "lock") return <Lock size={18} aria-hidden="true" />;
  if (icon === "sleep") return <Moon size={18} aria-hidden="true" />;
  if (icon === "monitor") return <Monitor size={18} aria-hidden="true" />;
  return <ShieldAlert size={18} aria-hidden="true" />;
}

function disconnectedSpec(
  reasonKind: DesktopReasonKind | null,
  error: string | undefined,
  hasSavedConsole: boolean,
): DisconnectedCardSpec {
  switch (reasonKind) {
    case "kicked":
      return {
        title: t("desktop.reason.kickedTitle"),
        sub: t("desktop.reason.kickedSub"),
        tone: "",
        icon: "monitor",
        showRecovery: false,
        autoExpandRecovery: false,
        showStatusCmd: false,
        reconnectLabel: t("desktop.takeOver"),
      };
    case "locked":
      return {
        title: t("desktop.reason.lockedTitle"),
        sub: t("desktop.reason.lockedSub"),
        tone: " is-warn",
        icon: "lock",
        showRecovery: true,
        autoExpandRecovery: hasSavedConsole,
        showStatusCmd: false,
        reconnectLabel: t("desktop.reconnect"),
      };
    case "sleeping":
      return {
        title: t("desktop.reason.sleepingTitle"),
        sub: t("desktop.reason.sleepingSub"),
        tone: " is-warn",
        icon: "sleep",
        showRecovery: true,
        autoExpandRecovery: hasSavedConsole,
        showStatusCmd: false,
        reconnectLabel: t("desktop.reconnect"),
      };
    case "perm_screen":
      return {
        title: t("desktop.reason.permScreenTitle"),
        sub: t("desktop.reason.permScreenSub"),
        tone: " is-error",
        icon: "perm",
        showRecovery: false,
        autoExpandRecovery: false,
        showStatusCmd: true,
        reconnectLabel: t("desktop.reconnect"),
      };
    case "perm_accessibility":
      return {
        title: t("desktop.reason.permAccessibilityTitle"),
        sub: t("desktop.reason.permAccessibilitySub"),
        tone: " is-error",
        icon: "perm",
        showRecovery: false,
        autoExpandRecovery: false,
        showStatusCmd: true,
        reconnectLabel: t("desktop.reconnect"),
      };
    case "stopped_on_host":
      return {
        title: t("desktop.reason.stoppedHostTitle"),
        sub: t("desktop.reason.stoppedHostSub"),
        tone: " is-warn",
        icon: "monitor",
        showRecovery: false,
        autoExpandRecovery: false,
        showStatusCmd: false,
        reconnectLabel: t("desktop.reconnect"),
      };
    case "display_unavailable":
      return {
        title: t("desktop.reason.displayUnavailableTitle"),
        sub: t("desktop.reason.displayUnavailableSub"),
        tone: " is-warn",
        icon: "monitor",
        showRecovery: false,
        autoExpandRecovery: false,
        showStatusCmd: false,
        reconnectLabel: t("desktop.reconnect"),
      };
    default: {
      const hasError = Boolean(error);
      return {
        title: hasError ? error! : t("desktop.disconnectedTitle"),
        sub: hasError ? undefined : t("desktop.disconnectedSub"),
        tone: hasError ? " is-error" : "",
        icon: hasError ? "lock" : "default",
        showRecovery: true,
        autoExpandRecovery: false,
        showStatusCmd: false,
        reconnectLabel: t("desktop.reconnect"),
      };
    }
  }
}

export function DesktopPreflight({
  kind,
  hostName,
  connectingStep = "p2p",
  reconnectAttempt = 1,
  maxReconnectAttempts = 4,
  mode,
  quality,
  error,
  reasonKind,
  onReconnect,
  onRetryDirect,
  onCancel,
  onBack,
  onOpenSettings,
}: PreflightProps) {
  const [copied, confirmCopy] = useCopied<"setup" | "status">();
  const { credential, computers } = useComputers();
  const setupCmd = t("desktop.setupCommand");
  const statusCmd = t("desktop.statusCommand");
  const activeHost = credential ?? computers[0] ?? null;
  const savedConsole = activeHost ? readConsole(activeHost) : "";

  async function copyCommand(slot: "setup" | "status", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      confirmCopy(slot);
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
          <CopyCommandBox
            command={setupCmd}
            copied={copied === "setup"}
            onCopy={() => void copyCommand("setup", setupCmd)}
          />
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

  const resolvedReason = reasonKind !== undefined ? reasonKind : (error ? parseDesktopReason(error).kind : null);
  const spec = disconnectedSpec(resolvedReason, error, Boolean(savedConsole));

  return (
    <div className="rd-state-overlay">
      <div className="rd-state-card">
        <div className="rd-state-head">
          <div className={`rd-state-icon${spec.tone}`}>
            {renderDisconnectedIcon(spec.icon)}
          </div>
          <div>
            <h2 className="rd-state-title">{spec.title}</h2>
            <div className="rd-state-host">{hostName}</div>
          </div>
        </div>
        {spec.sub && <p className="rd-state-sub">{spec.sub}</p>}
        {spec.showStatusCmd && (
          <CopyCommandBox
            command={statusCmd}
            copied={copied === "status"}
            onCopy={() => void copyCommand("status", statusCmd)}
          />
        )}
        {spec.showRecovery && (
          <div className="rd-recovery-wrap">
            <RecoveryConsole defaultOpen={spec.autoExpandRecovery} />
          </div>
        )}
        <div className="rd-state-actions">
          {onReconnect && (
            <Button className="btn btn-primary btn-small" onClick={onReconnect}>{spec.reconnectLabel}</Button>
          )}
          {onBack && (
            <Button className="btn btn-small" onClick={onBack}>{t("desktop.back")}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
