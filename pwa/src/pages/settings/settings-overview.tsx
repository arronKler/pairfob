import { openComputers } from "../../features/computers/actions";
import { DaemonUpdateRow } from "../../features/settings/daemon-update-view";
import { HerdSessionRow } from "../../features/herd-sessions/herd-session-row";
import { LanguageControl } from "../../features/settings/language";
import { setSettingsSection } from "../../features/settings/settings-section";
import { t } from "../../lib/i18n";
import type { TermMode } from "../../lib/terminal-mode";
import { SetGroup, SetItem, SetNavItem } from "../../shared/ui/primitives";
import { AgentQuotaModule } from "../../pages/quota/quota-summary";
import { ComputerPanel, type LinkState } from "./computer-panel";
import { SessionDefaults } from "./settings-defaults";
import { NotificationItem, type NotificationRowInput } from "./settings-notifications";

export type SettingsOverviewInput = {
  computerName: string;
  link: LinkState;
  computerCount: number;
  defaultTermMode: TermMode;
  defaultComposeLive: boolean;
  composeEnterSends: boolean;
  notification: NotificationRowInput;
  /** The desktop names the local group for the device, not the phone. */
  desk: boolean;
};

/**
 * The Settings overview: the computer panel (tap for the computer page), the
 * quota module, the session defaults chosen in place, then this device's
 * notifications and language. Nothing here opens a sheet; explanations sit in
 * the notes under each card.
 */
export function SettingsOverview({ input }: { input: SettingsOverviewInput }) {
  return (
    <>
      <ComputerPanel name={input.computerName} link={input.link} onOpen={() => setSettingsSection("connection")}>
        <DaemonUpdateRow />
        <HerdSessionRow />
        <SetNavItem label={t("settings.switchComputer")} value={t("settings.countUnit", { n: String(input.computerCount) })}
          onClick={openComputers} />
      </ComputerPanel>
      <AgentQuotaModule />
      <SessionDefaults mode={input.defaultTermMode} live={input.defaultComposeLive} enterSends={input.composeEnterSends} />
      <SetGroup label={t(input.desk ? "set.deviceSection" : "settings.phoneSection")}>
        <NotificationItem input={input.notification} />
        <SetItem className="language-item" label={t("settings.language")} trailing={<LanguageControl className="set-seg" />} />
      </SetGroup>
    </>
  );
}
