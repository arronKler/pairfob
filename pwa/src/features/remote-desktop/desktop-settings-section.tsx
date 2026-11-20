import { useId, useSyncExternalStore } from "react";
import { Check, Copy, Monitor } from "lucide-react";
import { t } from "../../lib/i18n";
import type { DesktopQuality } from "../../lib/protocol/remote-desktop";
import { readConsole } from "../../lib/recovery-console";
import { useCopied } from "../../shared/react/use-copied";
import {
  Button,
  CopyAck,
  SegmentedControl,
  SegmentedOption,
  SetAction,
  SetGroup,
  SetItem,
  SetSwitch,
  SetTag,
} from "../../shared/ui/primitives";
import { useComputers } from "../computers/hooks";
import { useCapabilities } from "../operations/hooks";
import { setDefaultAudio, setDefaultMode, setDefaultQuality, useDesktopPrefs } from "./desktop-prefs";
import { RecoveryConsole } from "./recovery-console";
import "./desktop.scss";

const QUALITIES: ReadonlyArray<DesktopQuality> = ["balanced", "detail", "motion"];

function followConsole(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("pairfob-recovery-change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("pairfob-recovery-change", listener);
  };
}

export function DesktopSettingsSection({
  connected,
  onOpenDesktop,
}: {
  connected: boolean;
  onOpenDesktop: () => void;
}) {
  const caps = useCapabilities().operationCapabilities;
  const prefs = useDesktopPrefs();
  const audioLabelId = useId();
  const [copied, confirmCopy] = useCopied<"cmd" | "failed">();
  const { credential, computers } = useComputers();
  const host = credential || computers[0];
  const savedConsole = useSyncExternalStore(followConsole, () => (host ? readConsole(host) : ""));

  const canView = caps.view_desktop === true;
  const canSetup = caps.setup_desktop === true;

  if (!canView && !canSetup) {
    if (!savedConsole) return null;
    return (
      <SetGroup label={t("recovery.title")}>
        <div className="set-item-block">
          <RecoveryConsole />
        </div>
      </SetGroup>
    );
  }

  if (!canView && canSetup) {
    const setupCmd = t("desktop.setupCommand");
    const copyState = copied === "cmd" ? "copied" : copied === "failed" ? "failed" : "idle";
    async function copySetupCommand() {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(setupCmd);
        confirmCopy("cmd");
      } catch {
        confirmCopy("failed");
      }
    }
    return (
      <SetGroup className="rd-settings-group rd-setup-group" label={t("desktop.setupTitle")}>
        <div className="set-item-block rd-setup-block">
          <p className="rd-setup-body">{t("desktop.setupBody")}</p>
          <div className="rd-cmd-copy">
            <code>{setupCmd}</code>
            <Button className="rd-copy-btn" onClick={() => void copySetupCommand()}>
              <CopyAck
                state={copyState}
                idle={<><Copy size={13} aria-hidden="true" />{t("desktop.copy")}</>}
                copied={<><Check size={13} aria-hidden="true" />{t("desktop.copied")}</>}
                failed={t("desktop.copyFailed")}
              />
            </Button>
          </div>
          <p className="rd-setup-note">{t("desktop.setupNote")}</p>
        </div>
        <div className="set-item-block">
          <RecoveryConsole />
        </div>
      </SetGroup>
    );
  }

  return (
    <SetGroup
      className="rd-settings-group"
      label={t("desktop.settingsGroup")}
      aside={
        <SetAction tone="fill" disabled={!connected} onClick={onOpenDesktop}>
          <Monitor size={14} aria-hidden="true" />
          {t("desktop.openDesktop")}
        </SetAction>
      }
    >
      <div className="rd-cap-strip" role="list" aria-label={t("desktop.title")}>
        <span role="listitem">
          <SetTag tone={caps.view_desktop ? "ok" : undefined}>{t("desktop.capView")}</SetTag>
        </span>
        <span role="listitem">
          <SetTag tone={caps.control_desktop ? "ok" : undefined}>{t("desktop.capControl")}</SetTag>
        </span>
        <span role="listitem">
          <SetTag tone={caps.listen_desktop_audio ? "ok" : undefined}>{t("desktop.capAudio")}</SetTag>
        </span>
      </div>

      <SetItem
        label={t("desktop.prefMode")}
        sub={t("desktop.prefModeSub")}
        trailing={
          <SegmentedControl className="set-seg" aria-label={t("desktop.prefMode")}>
            <SegmentedOption selected={prefs.defaultMode === "control"} onClick={() => setDefaultMode("control")}>
              {t("desktop.modeControlShort")}
            </SegmentedOption>
            <SegmentedOption selected={prefs.defaultMode === "view"} onClick={() => setDefaultMode("view")}>
              {t("desktop.modeViewShort")}
            </SegmentedOption>
          </SegmentedControl>
        }
      />

      <SetItem
        label={t("desktop.prefQuality")}
        sub={t("desktop.prefQualitySub")}
        trailing={
          <SegmentedControl className="set-seg" aria-label={t("desktop.prefQuality")}>
            {QUALITIES.map(quality => (
              <SegmentedOption
                key={quality}
                selected={prefs.defaultQuality === quality}
                onClick={() => setDefaultQuality(quality)}
              >
                {t(`desktop.${quality}`)}
              </SegmentedOption>
            ))}
          </SegmentedControl>
        }
      />

      <SetItem
        label={t("desktop.prefAudio")}
        labelId={audioLabelId}
        sub={t("desktop.prefAudioSub")}
        trailing={
          <SetSwitch
            checked={prefs.defaultAudio}
            labelledBy={audioLabelId}
            onChange={setDefaultAudio}
          />
        }
      />

      <div className="set-item-block">
        <RecoveryConsole />
      </div>
    </SetGroup>
  );
}
