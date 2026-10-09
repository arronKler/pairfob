import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useRememberedScroll } from "../../shared/ui/dom/remembered-scroll";
import { useComputers } from "../../features/computers/hooks";
import { useConnection, useRuntime } from "../../features/connection/hooks";
import { usePreferences } from "../../features/settings/hooks";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { leaveSettings } from "../../features/settings/actions";
import { useLang } from "../../features/settings/language";
import { setSettingsSection, settingsSection, subscribeSettingsSection } from "../../features/settings/settings-section";
import { herdStatusOf } from "../../features/connection/herd-status";
import { AppNotice } from "../../app/notice";
import { BackBar } from "../../shared/ui/primitives";
import { linkState } from "./computer-panel";
import { useNameUnderBar } from "./name-under-bar";
import { ComputerSection } from "./settings-computer";
import { SettingsOverview } from "./settings-overview";

/**
 * Settings: the overview, and the computer page behind its computer panel. On
 * a phone the overview is a tab root (no back); on the desktop it keeps its
 * back bar. The computer page's panel names the computer, so its bar says only
 * "Computer" at rest; the bar stays in place while the page scrolls, and takes
 * the name over once the panel has carried it out of sight (`name-under-bar`).
 */
function useSettingsView() {
  const connection = useConnection();
  const runtime = useRuntime();
  const preferences = usePreferences();
  const computers = useComputers();
  const section = useSyncExternalStore(subscribeSettingsSection, settingsSection);
  // However Settings is left — back, a tab, a desk page swap — it reopens on the overview.
  useEffect(() => () => setSettingsSection("overview"), []);
  // The overview keeps its place across tabs and a detail page; a detail page
  // always opens at its top.
  useRememberedScroll("settings", section === "overview");
  useLayoutEffect(() => {
    if (section !== "overview") window.scrollTo(0, 0);
  }, [section]);
  return { connection, runtime, preferences, computers, section };
}

export function SettingsContent({ withBack }: { withBack: boolean }) {
  const { connection, runtime, preferences, computers, section } = useSettingsView();
  useLang();
  // Project the status row from the same published snapshots the surrounding
  // panel reads. The live handle is the snapshot's opaque identity; a staged
  // composition hold keeps the panel on the published phase/online values until
  // the queued commit, so the row can never show offline a frame early.
  const connected = computers.live?.isConnected() === true;
  const status = herdStatusOf({
    connected,
    checking: computers.live?.isChecking?.() === true,
    networkOnline: connection.networkOnline,
    runtimeKind: runtime.runtimeKind,
    herdHost: runtime.herdHost,
    reading: runtime.identityPending,
  });
  const network = {
    sessionTransport: connection.sessionTransport,
    relayRttMs: connection.relayRttMs,
    p2pEnabled: connection.p2pEnabled,
    networkMode: connection.networkMode,
    lastP2PAttempt: connection.lastP2PAttempt,
  };
  const computerName = runtime.herdHost || (computers.credential ? computerTitle(computers.credential) : t("settings.currentComputer"));
  const link = linkState(status, network, connected);
  const back = section === "overview" ? (withBack ? leaveSettings : null) : () => setSettingsSection("overview");
  const named = useNameUnderBar(section === "connection");
  const title = section === "connection" ? (named ? computerName : t("settings.computer")) : t("settings.title");
  return (
    <>
      {back ? <BackBar title={title} onBack={back} />
        : <h1 className="settings-title">{title}</h1>}
      <AppNotice />
      {section === "connection" ? (
        <ComputerSection name={computerName} link={link} connection={connection} runtime={runtime} connected={connected} />
      ) : (
        <SettingsOverview input={{
          computerName,
          link,
          computerCount: computers.computers.length || 1,
          defaultTermMode: preferences.defaultTermMode,
          defaultComposeLive: preferences.defaultComposeLive,
          composeEnterSends: preferences.composeEnterSends,
          notification: {
            loading: runtime.settingsLoading,
            connected,
            supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
            pushEnabled: runtime.pushEnabled,
            pushSubscribed: runtime.pushSubscribed,
            error: runtime.pushConfigError,
          },
          desk: withBack,
        }} />
      )}
    </>
  );
}

/** The phone Settings tab root. The desktop mounts `SettingsContent` in the desk shell. */
export function SettingsScreen() {
  return (
    <div className="page settings-page">
      <SettingsContent withBack={false} />
    </div>
  );
}
