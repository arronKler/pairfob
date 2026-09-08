import { updateInProgress } from "../lib/daemon-update-status";
import { daemonVersion, needsDaemonUpdate, startDaemonUpdate, refreshDaemonUpdate, checkDaemonRelease, setDaemonUpdateRenderer, daemonReleaseCheckState } from "../daemon-update";
import { legacyBuild } from "../lib/daemon-version";
import { button, node, askConfirm } from "../lib/dom";
import { t } from "../lib/i18n";
import { state } from "../state";
import { adoptScreen } from "../compose-drafts";
import { render } from "../paint";

setDaemonUpdateRenderer(() => {
  for (const host of document.querySelectorAll<HTMLElement>("[data-daemon-update]")) {
    if (host.dataset.daemonUpdate !== (state.credential?.daemonId || "")) continue;
    host.replaceChildren();
    fillDaemonUpdate(host, host.dataset.detailed === "true");
    host.hidden = !host.childNodes.length;
  }
});

export function appendDaemonUpdate(root: HTMLElement | DocumentFragment, detailed = false): void {
  const host = node("div", "daemon-update-host");
  host.dataset.daemonUpdate = state.credential?.daemonId || "";
  host.dataset.detailed = String(detailed);
  fillDaemonUpdate(host, detailed);
  host.hidden = !host.childNodes.length;
  root.append(host);
}

export function appendManualUpdateHelp(root: HTMLElement | DocumentFragment): void {
  const help = node("details", "set-card");
  help.append(node("summary", "", t("update.helpTitle")));
  help.append(node("p", "set-note", t("update.helpBody")));
  appendUpdateCommand(help);
  root.append(help);
}

function appendUpdateCommand(body: HTMLElement): void {
  body.append(node("code", "", "pairfob update"));
  const copy = button(t("update.copyCommand"), "btn btn-small", () => {
    void navigator.clipboard.writeText("pairfob update").then(() => {
      copy.textContent = t("update.copied");
    }).catch(() => {
      copy.textContent = t("update.copyManual");
    });
  });
  body.append(copy);
}

function phaseCopy(phase: string, build: string, target: string): string {
  switch (phase) {
    case "downloading":
      return t("update.downloading");
    case "restarting":
      return t("update.restarting");
    case "verifying":
      return t("update.verifying");
    case "complete":
      return build === target ? t("update.complete") : t("update.waitConfirm");
    case "failed":
      return t("update.failed");
    case "rolled_back":
      return t("update.rolledBack");
    default:
      return "";
  }
}

function fillDaemonUpdate(root: HTMLElement, detailed: boolean): void {
  const known = daemonVersion();
  if (!known) {
    if (detailed) appendManualUpdateHelp(root);
    return;
  }
  const view = known;
  if (!detailed && !needsDaemonUpdate(view)) return;
  const key = `pairfob-update-later:${state.credential?.daemonId}:${legacyBuild(view.build) ? "legacy" : view.latest}`;
  if (!detailed) {
    try {
      if (Date.now() - Number(localStorage.getItem(key)) < 86400000) return;
    } catch { /* unavailable storage */ }
  }
  const section = node("section", detailed ? "daemon-update daemon-update-footer" : "set-card daemon-update");
  const body = node("div", detailed ? "daemon-update-content" : "set-row set-row-stack");
  const old = legacyBuild(view.build) || view.incompatible;
  if (!detailed) {
    body.append(node("strong", "", old ? t("update.legacyTitle") : t("update.availableTitle")));
    body.append(node("p", "set-note", old ? t("update.legacyNote") : `${view.build} → ${view.latest}`));
  }
  if (detailed) {
    const checking = daemonReleaseCheckState() === "checking";
    const check = button(t(checking ? "update.checking" : "update.check"), "btn daemon-update-check", async () => {
      view.checkedManually = true;
      await checkDaemonRelease(true);
      await refreshDaemonUpdate();
    });
    check.disabled = checking;
    check.setAttribute("aria-busy", String(checking));
    if (checking) {
      const spinner = node("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      check.prepend(spinner);
    }
    const row = node("div", "daemon-update-version-row");
    const version = node("div", "daemon-update-version");
    version.append(node("span", "", t("update.computerVersion")), node("code", "", view.build || t("status.unknown")));
    row.append(version, check);
    body.append(row);
    const feedback = node("p", "daemon-update-feedback");
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    if (checking) {
      feedback.textContent = t("update.querying");
    } else if (view.error || daemonReleaseCheckState() === "error") {
      feedback.dataset.tone = "error";
      feedback.textContent = t("update.checkFailed");
    } else if (old) {
      feedback.dataset.tone = "warn";
      feedback.textContent = t("update.needManual");
    } else if (needsDaemonUpdate(view)) {
      feedback.dataset.tone = "warn";
      feedback.textContent = t("update.newVersion", { version: view.latest });
    } else if (daemonReleaseCheckState() === "success") {
      feedback.dataset.tone = "ok";
      feedback.textContent = view.build === view.latest ? t("update.latest") : t("update.noAuto");
    } else {
      feedback.textContent = t("update.checkHint");
    }
    if (view.checkedManually || needsDaemonUpdate(view)) body.append(feedback);
    const status = view.status;
    if (status && status.phase !== "idle") {
      const progress = node("p", "daemon-update-feedback", phaseCopy(status.phase, view.build, status.target));
      progress.setAttribute("role", "status");
      if (status.phase === "failed" || status.phase === "rolled_back") progress.dataset.tone = "error";
      body.append(progress);
    }
    if (view.rejected) body.append(node("p", "set-note", t("update.rejected")));
    if (view.uncertain) body.append(node("p", "set-note", t("update.uncertain")));
    if (needsDaemonUpdate(view)) {
      if (status?.available && !old) {
        const update = button(t("update.now"), "btn btn-small btn-primary", () => {
          const session = state.live;
          void askConfirm(t("update.confirm")).then((yes) => {
            if (yes && session === state.live) void startDaemonUpdate();
          });
        });
        update.disabled = !!view.requesting || !!view.uncertain || updateInProgress(status) || !state.live?.isConnected();
        body.append(update);
      }
      if (status && status.phase !== "idle") {
        body.append(button(t("update.refresh"), "btn btn-small btn-ghost", () => void refreshDaemonUpdate()));
      }
      appendUpdateCommand(body);
    }
  } else {
    body.append(button(t("update.view"), "btn btn-small", () => {
      adoptScreen("settings");
      render();
      document.querySelector('[data-detailed="true"]')?.scrollIntoView({ block: "nearest" });
      void checkDaemonRelease();
      void refreshDaemonUpdate();
    }));
    body.append(button(t("update.later"), "btn btn-small btn-ghost", () => {
      try { localStorage.setItem(key, String(Date.now())); } catch { /* unavailable storage */ }
      root.replaceChildren();
      root.hidden = true;
    }));
  }
  section.append(body);
  root.append(section);
}
