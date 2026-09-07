import { updateInProgress } from "../lib/daemon-update-status";
import { daemonVersion, needsDaemonUpdate, startDaemonUpdate, refreshDaemonUpdate, checkDaemonRelease, setDaemonUpdateRenderer, daemonReleaseCheckState } from "../daemon-update";
import { legacyBuild } from "../lib/daemon-version";
import { button, node, askConfirm } from "../lib/dom";
import { lang } from "../lib/i18n";
import { state } from "../state";
import { adoptScreen } from "../compose-drafts";
import { render } from "../paint";
export function updateCopy(zh: string, en: string): string { return lang() === "zh" ? zh : en; }
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
  help.append(node("summary", "", updateCopy("电脑端很久没更新或无法连接？", "Computer outdated or unable to connect?")));
  help.append(node("p", "set-note", updateCopy("连接失败也可能由网络或电脑离线引起。若电脑端长期未更新，请在那台电脑执行下方命令，然后重新连接。", "Connection failures may also mean the computer is offline or the network is unavailable. If the computer software is outdated, run this command there, then reconnect.")));
  appendUpdateCommand(help);
  root.append(help);
}
function appendUpdateCommand(body: HTMLElement): void {
  body.append(node("code", "", "pairfob update"));
  const copy = button(updateCopy("复制更新命令", "Copy update command"), "btn btn-small", () => {
    void navigator.clipboard.writeText("pairfob update").then(() => { copy.textContent = updateCopy("已复制", "Copied"); }).catch(() => { copy.textContent = updateCopy("请手动复制上方命令", "Copy the command above manually"); });
  });
  body.append(copy);
}
function fillDaemonUpdate(root: HTMLElement, detailed: boolean): void {
  const known = daemonVersion();
  if (!known) { if (detailed) appendManualUpdateHelp(root); return; }
  const view = known;
  if (!detailed && !needsDaemonUpdate(view)) return;
  const key = `pairfob-update-later:${state.credential?.daemonId}:${legacyBuild(view.build) ? "legacy" : view.latest}`;
  if (!detailed) {
    try { if (Date.now() - Number(localStorage.getItem(key)) < 86400000) return; } catch { /* unavailable storage */ }
  }
  const section = node("section", detailed ? "daemon-update daemon-update-footer" : "set-card daemon-update");
  const body = node("div", detailed ? "daemon-update-content" : "set-row set-row-stack");
  const old = legacyBuild(view.build) || view.incompatible;
  if (!detailed) {
    body.append(node("strong", "", updateCopy(old ? "电脑端版本较旧或不兼容，请手动升级" : "电脑端有更新", old ? "Computer version is old or incompatible; update manually" : "Computer update available")));
    body.append(node("p", "set-note", old ? updateCopy("请在电脑执行一次 pairfob update。", "Run pairfob update once on the computer.") : `${view.build} → ${view.latest}`));
  }
  if (detailed) {
    const checking = daemonReleaseCheckState() === "checking";
    const check = button(updateCopy(checking ? "正在检查…" : "检查更新", checking ? "Checking…" : "Check for updates"), "btn daemon-update-check", async () => {
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
    version.append(node("span", "", updateCopy("电脑端版本", "Computer version")), node("code", "", view.build || updateCopy("未知", "Unknown")));
    row.append(version, check);
    body.append(row);
    const feedback = node("p", "daemon-update-feedback");
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    if (checking) {
      feedback.textContent = updateCopy("正在查询最新版本，请稍候…", "Checking the latest release. Please wait…");
    } else if (view.error || daemonReleaseCheckState() === "error") {
      feedback.dataset.tone = "error";
      feedback.textContent = updateCopy("检查失败，暂时无法获取最新版本。请重试；也会稍后自动检查。", "Check failed: the latest release is unavailable. Try again; an automatic retry is also scheduled.");
    } else if (old) {
      feedback.dataset.tone = "warn";
      feedback.textContent = updateCopy("需要在电脑手动升级一次，之后才能使用手机更新。", "Update manually on the computer once to enable updates from your phone.");
    } else if (needsDaemonUpdate(view)) {
      feedback.dataset.tone = "warn";
      feedback.textContent = updateCopy(`发现新版本 ${view.latest}，可在下方更新电脑端。`, `Version ${view.latest} is available. Update the computer below.`);
    } else if (daemonReleaseCheckState() === "success") {
      feedback.dataset.tone = "ok";
      feedback.textContent = view.build === view.latest
        ? updateCopy("检查完成，电脑端已是最新版本。", "Check complete. Your computer is up to date.")
        : updateCopy("检查完成，未发现可自动更新的版本。", "Check complete. No automatic update is available.");
    } else {
      feedback.textContent = updateCopy("点击上方按钮，检查电脑端是否有新版本。", "Use the button above to check for computer updates.");
    }
    if (view.checkedManually || needsDaemonUpdate(view)) body.append(feedback);
    const status = view.status;
    if (status && status.phase !== "idle") {
      const messages = {
        downloading: ["正在下载并校验…", "Downloading and verifying…"],
        restarting: ["正在重启，连接将自动恢复…", "Restarting; the connection will recover…"],
        verifying: ["正在验证新版本…", "Verifying the new version…"],
        complete: view.build === status.target ? ["更新完成", "Update complete"] : ["等待确认运行版本", "Waiting to confirm the running version"],
        failed: ["更新未完成，请检查状态或在电脑端更新。", "Update failed. Check status or update on the computer."],
        rolled_back: ["新版本启动失败，已恢复旧版本。", "The new version failed to start; the previous version was restored."],
      };
      const copy = messages[status.phase];
      const progress = node("p", "daemon-update-feedback", updateCopy(copy[0], copy[1]));
      progress.setAttribute("role", "status");
      if (status.phase === "failed" || status.phase === "rolled_back") progress.dataset.tone = "error";
      body.append(progress);
    }
    if (view.rejected) body.append(node("p", "set-note", updateCopy("更新请求未被接受，请检查最新状态。", "Update was not accepted. Check the latest status.")));
    if (view.uncertain) body.append(node("p", "set-note", updateCopy("更新结果尚未确认，正在查询；不会自动重试。", "Update outcome is unconfirmed. Checking status without retrying.")));
    if (needsDaemonUpdate(view)) {
      if (status?.available && !old) {
        const update = button(updateCopy("更新电脑端", "Update computer"), "btn btn-small btn-primary", () => {
          const session = state.live;
          void askConfirm(updateCopy("更新会短暂断开连接，随后自动重连。现在更新电脑端？", "Updating briefly disconnects this device, then reconnects. Update the computer now?")).then(yes => { if (yes && session === state.live) void startDaemonUpdate(); });
        });
        update.disabled = !!view.requesting || !!view.uncertain || updateInProgress(status) || !state.live?.isConnected();
        body.append(update);
      }
      if (status && status.phase !== "idle") body.append(button(updateCopy("刷新更新进度", "Refresh update progress"), "btn btn-small btn-ghost", () => void refreshDaemonUpdate()));
      appendUpdateCommand(body);
    }
  } else {
    body.append(button(updateCopy("查看更新", "View update"), "btn btn-small", () => { adoptScreen("settings"); render(); document.querySelector('[data-detailed="true"]')?.scrollIntoView({ block: "nearest" }); void checkDaemonRelease(); void refreshDaemonUpdate(); }));
    body.append(button(updateCopy("明天提醒", "Remind me tomorrow"), "btn btn-small btn-ghost", () => { try { localStorage.setItem(key, String(Date.now())); } catch { /* unavailable storage */ } root.replaceChildren(); root.hidden = true; }));
  }
  section.append(body); root.append(section);
}
