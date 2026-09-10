import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import type { PairResult } from "../../lib/protocol/client";
import { formatDeviceAge } from "../../lib/ui-model";

/**
 * Pure projection from the paired-computer catalog to what the picker paints.
 *
 * No application state, no paint loop, no DOM: the caller supplies the catalog,
 * which daemon is current, whether the application is live, and where a back
 * action should land. That keeps the three copy rules this screen has — current,
 * last used, never connected — testable without a session.
 */

export type ComputersBackTarget = "settings" | "pane" | "home";

export type ComputerRowModel = {
  daemonId: string;
  title: string;
  meta: string;
  current: boolean;
  currentPill: string | null;
  forgetAria: string;
  forgetLabel: string;
};

export type ComputersViewModel = {
  withBack: boolean;
  backTitle: string;
  backTarget: ComputersBackTarget;
  /** Null when a back bar carries the title instead of a prelude heading. */
  heading: { title: string; lede: string } | null;
  rows: ComputerRowModel[];
  addLabel: string;
  addHint: string;
  showManualUpdateHelp: boolean;
  pageClass: string;
};

export type ComputersViewInput = {
  computers: readonly PairResult[];
  credentialDaemonId: string | null;
  /** The application is on an established session, so the picker is a settings page. */
  live: boolean;
  lastUsedDaemonId: string | null;
  computersFrom: "home" | "settings";
  desk: boolean;
  paneId: string;
  withBack: boolean;
};

/** One stored computer is an offline retry; more than one is a machine chooser. */
function heading(computers: readonly PairResult[]): { title: string; lede: string } {
  return computers.length > 1
    ? { title: t("computers.pick"), lede: t("computers.multiLede") }
    : { title: t("computers.offlineTitle"), lede: t("computers.offlineLede") };
}

function rowMeta(pair: PairResult, current: boolean, lastUsedDaemonId: string | null): string {
  const lastSeen = pair.lastSeen || pair.createdAt;
  if (current) return t("computers.current");
  if (lastUsedDaemonId === pair.daemonId) return t("computers.lastUsed", { when: formatDeviceAge(lastSeen) });
  return lastSeen ? t("device.lastUsed", { when: formatDeviceAge(lastSeen) }) : t("computers.neverConnected");
}

/** Where a back action lands: settings if it opened from there, else the open pane, else home. */
export function computersBackTarget(input: Pick<ComputersViewInput, "computersFrom" | "desk" | "paneId">): ComputersBackTarget {
  if (input.computersFrom === "settings") return "settings";
  return input.desk && input.paneId ? "pane" : "home";
}

export function computersViewModel(input: ComputersViewInput): ComputersViewModel {
  const { computers, credentialDaemonId, live, lastUsedDaemonId, withBack } = input;
  return {
    withBack,
    backTitle: t("computers.title"),
    backTarget: computersBackTarget(input),
    heading: withBack ? null : heading(computers),
    rows: computers.map(pair => {
      const current = live && credentialDaemonId === pair.daemonId;
      const title = computerTitle(pair);
      return {
        daemonId: pair.daemonId,
        title,
        current,
        currentPill: current ? t("computers.currentPill") : null,
        meta: rowMeta(pair, current, lastUsedDaemonId),
        forgetAria: t("computers.forgetAria", { title }),
        forgetLabel: t("forget"),
      };
    }),
    addLabel: t("settings.addComputer"),
    addHint: t("computers.addHint"),
    showManualUpdateHelp: !withBack && computers.length > 0,
    pageClass: live ? "page settings-page" : "page",
  };
}
