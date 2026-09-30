import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import { BoardPage } from "../../pages/board";
import { ComputersContent } from "../../pages/computers/computers-page";
import { HomeRail } from "../../pages/home";
import { QuotaContent } from "../../pages/quota/quota-page";
import { SettingsContent } from "../../pages/settings/settings-page";
import { AppNotice } from "../notice";
import type { DeskPage } from "../layout";

/** The desk pane opened from the board leads back to it; the rail stays put. */
function DeskReturn({ onReturn }: { onReturn: () => void }) {
  return <button type="button" className="desk-return text-link" onClick={onReturn}>
    <ChevronLeft size={18} aria-hidden="true" /><span>{t("desk.backToBoard")}</span>
  </button>;
}

/**
 * Desktop shell.
 *
 * The desk layout is application composition: the subscribed herd rail beside a
 * main column. Which page fills the main column is the prepared layout's
 * `deskPage` (settings / quota / computers / board), else the displayed session
 * child `<App/>` hands in, else the pick prompt. A pane opened from the board
 * gets `onReturn`, a way back to the board above it. The shell reads that one
 * typed descriptor — never the whole state record, and never the paint bridge.
 *
 * The `key` preserves the historical remount boundary: changing the settings
 * family remounts the main section, while chat/guided swaps inside the same
 * section exactly as the old `state.screen === "pane"` branch did.
 */
export function DeskShell({ deskPage, children, onReturn }: {
  deskPage: DeskPage;
  children?: ReactNode;
  onReturn?: () => void;
}) {
  const settings = deskPage === "settings" || deskPage === "quota" || deskPage === "computers";
  return <>
    <HomeRail />
    <section key={deskPage ?? "main"} className={`main${settings ? " main-settings" : deskPage === "board" ? " main-board" : ""}`}>
      {deskPage === "settings" ? <SettingsContent withBack />
        : deskPage === "quota" ? <QuotaContent />
        : deskPage === "computers" ? <ComputersContent withBack />
        : deskPage === "board" ? <BoardPage />
        : children ? <>{onReturn ? <DeskReturn onReturn={onReturn} /> : null}{children}</> : <>
          <AppNotice />
          <div className="main-empty"><p className="empty-title">{t("desk.pickTitle")}</p>
            <p className="empty-sub">{t("desk.pickSub")}</p></div>
        </>}
    </section>
  </>;
}
