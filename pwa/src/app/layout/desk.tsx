import { ChevronLeft } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { guardBackTap } from "../../shared/ui/dom/back-tap";
import { BoardPage } from "../../pages/board";
import { ComputersContent } from "../../pages/computers/computers-page";
import { HomeRail } from "../../pages/home";
import { QuotaContent } from "../../pages/quota/quota-page";
import { SettingsContent } from "../../pages/settings/settings-page";
import { WorkspaceInspector } from "../../pages/workspace/inspector";
import { AppNotice } from "../notice";
import { DeskEmpty } from "./desk-empty";
import type { DeskPage } from "../layout";
import { guardListReturn } from "./list-return";

/**
 * The desk pane opened from the board leads back to it; the rail stays put.
 * It is a back control like the header's, so a pointer press arms the same
 * double-tap guard (`shared/ui/dom/back-tap.ts`): the board's title comes up
 * under the strip, and the second half of a doubled tap must not open it.
 */
function DeskReturn({ onReturn }: { onReturn: () => void }) {
  return <button type="button" className="desk-return text-link" onClick={(event) => {
    if (event.detail !== 0) guardBackTap(event.currentTarget.ownerDocument, { x: event.clientX, y: event.clientY });
    onReturn();
  }}>
    <ChevronLeft size={18} aria-hidden="true" /><span>{t("desk.backToBoard")}</span>
  </button>;
}

/**
 * Desktop shell.
 *
 * The desk layout is application composition: the subscribed herd rail beside a
 * main column. Which page fills the main column is the prepared layout's
 * `deskPage` (settings / quota / computers / board), else the displayed session
 * child `<App/>` hands in, else the empty main. A pane opened from the board
 * gets `onReturn`, a way back to the board above it. With `inspector` the files
 * and changes sit in a third column beside the session; the rail stays mounted
 * and the shell class hides it when the layout has no room for all three, or
 * for the list beside the board. The shell reads that one typed descriptor —
 * never the whole state record, and never the paint bridge.
 *
 * The `key` preserves the historical remount boundary: changing the settings
 * family remounts the main section, while chat/guided swaps inside the same
 * section exactly as the old `state.screen === "pane"` branch did.
 */
export function DeskShell({ deskPage, children, onReturn, inspector = false }: {
  deskPage: DeskPage;
  children?: ReactNode;
  onReturn?: () => void;
  inspector?: boolean;
}) {
  const settings = deskPage === "settings" || deskPage === "quota" || deskPage === "computers";
  // The shell hides and returns the rail, so it also owns the click that can land on it in between.
  useEffect(guardListReturn, []);
  return <>
    <HomeRail />
    <section key={deskPage ?? "main"} className={`main${settings ? " main-settings" : deskPage === "board" ? " main-board" : ""}`}>
      {deskPage === "settings" ? <SettingsContent withBack />
        : deskPage === "quota" ? <QuotaContent />
        : deskPage === "computers" ? <ComputersContent withBack />
        : deskPage === "board" ? <BoardPage />
        : children ? <>{onReturn ? <DeskReturn onReturn={onReturn} /> : null}{children}</> : <>
          <AppNotice />
          <DeskEmpty />
        </>}
    </section>
    {inspector ? <WorkspaceInspector /> : null}
  </>;
}
