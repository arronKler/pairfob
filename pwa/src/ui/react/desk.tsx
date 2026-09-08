import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import { state } from "../../state";
import { QuotaContent } from "./agent-quota";
import { AppNotice } from "./chrome";
import { ComputersContent } from "./computers";
import { HomeRail, type HerdView } from "./home";
import { SettingsContent } from "./settings";

export function DeskScreen({ view, children }: { view: HerdView; children?: ReactNode }) {
  const settings = state.screen === "settings" || state.screen === "quota" || state.screen === "computers";
  return <>
    <HomeRail view={view} />
    <section key={state.screen} className={`main${settings ? " main-settings" : ""}`}>
      {state.screen === "settings" ? <SettingsContent withBack />
        : state.screen === "quota" ? <QuotaContent />
        : state.screen === "computers" ? <ComputersContent withBack />
        : children ?? <>
          <AppNotice />
          <div className="main-empty"><p className="empty-title">{t("desk.pickTitle")}</p>
            <p className="empty-sub">{t("desk.pickSub")}</p></div>
        </>}
    </section>
  </>;
}
