import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import { ComputersContent } from "../../pages/computers/computers-page";
import { HomeRail } from "../../pages/home";
import { QuotaContent } from "../../pages/quota/quota-page";
import { SettingsContent } from "../../pages/settings/settings-page";
import { AppNotice } from "../notice";
import type { DeskPage } from "../layout";

/**
 * Desktop shell.
 *
 * The desk layout is application composition: the subscribed herd rail beside a
 * main column. Which page fills the main column is the prepared layout's
 * `deskPage` (settings / quota / computers), else the displayed session child
 * `<App/>` hands in, else the pick prompt. The shell reads that one typed
 * descriptor — never the whole state record, and never the paint bridge.
 *
 * The `key` preserves the historical remount boundary: changing the settings
 * family remounts the main section, while chat/guided swaps inside the same
 * section exactly as the old `state.screen === "pane"` branch did.
 */
export function DeskShell({ deskPage, children }: { deskPage: DeskPage; children?: ReactNode }) {
  const settings = deskPage !== null;
  return <>
    <HomeRail />
    <section key={deskPage ?? "main"} className={`main${settings ? " main-settings" : ""}`}>
      {deskPage === "settings" ? <SettingsContent withBack />
        : deskPage === "quota" ? <QuotaContent />
        : deskPage === "computers" ? <ComputersContent withBack />
        : children ?? <>
          <AppNotice />
          <div className="main-empty"><p className="empty-title">{t("desk.pickTitle")}</p>
            <p className="empty-sub">{t("desk.pickSub")}</p></div>
        </>}
    </section>
  </>;
}
