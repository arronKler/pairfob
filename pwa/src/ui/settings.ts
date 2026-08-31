import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { type DeviceSummary } from "../lib/protocol/client";
import { formatDeviceAge, notificationAction, shortDeviceId, TERM_MODE_LABEL } from "../lib/ui-model";
import { beginAddComputer, openComputers } from "../computers";
import { computerTitle } from "../lib/computer-catalog";
import { revokeSelf } from "../live-operations";
import { enablePush, refreshSettings } from "../live-settings";
import { render } from "../paint";
import { app, setDefaultTermMode, state, type TermMode } from "../state";
import { isDesk } from "../viewport";
import { composeLiveControl } from "./session-view";
import { backBar, feedbackNode, herdStatus, languageControl, listGroupControl, noteNode, setRow } from "./chrome";

const TERM_MODE_OPTIONS: TermMode[] = ["guided", "full", "agent"];

function defaultTermModeControl(): HTMLElement {
  const bar = node("div", "seg");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", t("mode.defaultAria"));
  for (const id of TERM_MODE_OPTIONS) {
    const selected = state.defaultTermMode === id;
    const item = button(TERM_MODE_LABEL[id], `seg-item${selected ? " on" : ""}`, () => {
      if (state.defaultTermMode === id) return;
      setDefaultTermMode(id);
      render();
    });
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    bar.append(item);
  }
  return bar;
}

function deviceRow(device: DeviceSummary): HTMLElement {
  const row = node("div", "device");
  const head = node("div", "device-head");
  head.append(node("strong", "device-name", device.label || t("device.unnamed")));
  if (device.self) head.append(node("span", "pill pill-live", t("device.self")));
  if (device.revoked_at) head.append(node("span", "pill pill-off", t("device.revoked")));
  const id = node("code", "device-id", shortDeviceId(device.device_id));
  id.title = device.device_id;
  const activity = device.revoked_at
    ? t("device.revokedAt", { when: formatDeviceAge(device.revoked_at) })
    : t("device.lastUsed", { when: formatDeviceAge(device.last_seen || device.created_at) });
  const notifications = device.subscription_count ? t("device.notifyOn") : t("device.notifyOff");
  row.append(head, id, node("p", "device-meta", activity + notifications));
  return row;
}

export function fillSettings(container: HTMLElement | DocumentFragment, withBack: boolean): void {
  if (withBack) {
    container.append(
      backBar(t("settings.title"), () => {
        state.screen = isDesk() && state.paneId ? "pane" : "home";
        render();
      }),
    );
  }
  const status = herdStatus();
  container.append(node("h2", "set-title", t("settings.connection")));
  const conn = node("div", "set-card");
  conn.append(setRow(t("settings.computer"), state.herdHost || (state.credential ? computerTitle(state.credential) : t("settings.currentComputer"))));
  conn.append(setRow(t("settings.status"), status.text, status.tone));
  conn.append(setRow(
    t("settings.networkRtt"),
    state.relayRttMs === null ? t("settings.networkRttPending") : t("settings.networkRttMs", { ms: state.relayRttMs }),
  ));
  const self = state.deviceList.find((device) => device.self && !device.revoked_at);
  if (self) conn.append(setRow(t("settings.thisPhone"), self.label || t("settings.pairedPhone")));
  if (state.computers.length > 1) {
    const switchRow = node("div", "set-row set-row-stack");
    switchRow.append(node("p", "set-note", t("settings.computersCount", { n: state.computers.length })));
    switchRow.append(button(t("settings.switchComputer"), "btn btn-small", openComputers));
    conn.append(switchRow);
  }
  const addRow = node("div", "set-row set-row-stack");
  addRow.append(node("p", "set-note", t("settings.addComputerHint")));
  addRow.append(button(t("settings.addComputer"), "btn btn-small", beginAddComputer));
  conn.append(addRow);
  container.append(conn);

  container.append(node("h2", "set-title", t("settings.language")));
  const langCard = node("div", "set-card");
  const langRow = node("div", "set-row set-row-stack");
  langRow.append(node("p", "set-note", t("settings.languageNote")));
  langRow.append(languageControl());
  langCard.append(langRow);
  container.append(langCard);

  container.append(node("h2", "set-title", t("settings.list")));
  const listCard = node("div", "set-card");
  const listRow = node("div", "set-row set-row-stack");
  listRow.append(node("p", "set-note", t("settings.listNote")));
  listRow.append(listGroupControl());
  listCard.append(listRow);
  container.append(listCard);

  container.append(node("h2", "set-title", t("settings.mode")));
  const modeCard = node("div", "set-card");
  const modeRow = node("div", "set-row set-row-stack");
  modeRow.append(node("p", "set-note", t("settings.modeNote")));
  modeRow.append(defaultTermModeControl());
  modeCard.append(modeRow);
  container.append(modeCard);

  container.append(node("h2", "set-title", t("settings.input")));
  const inputCard = node("div", "set-card");
  const inputRow = node("div", "set-row set-row-stack");
  inputRow.append(node("p", "set-note", t("settings.inputNote")));
  inputRow.append(composeLiveControl());
  inputCard.append(inputRow);
  container.append(inputCard);

  container.append(node("h2", "set-title", t("settings.notifications")));
  const pushCard = node("div", "set-card");
  const pushRow = node("div", "set-row set-row-stack");
  pushRow.append(
    node(
      "p",
      "set-note",
      state.pushEnabled === false
        ? t("settings.pushComputerOff")
        : state.pushSubscribed === true
          ? t("settings.pushOn")
          : t("settings.pushOff"),
    ),
  );
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const pushAction = notificationAction(state.pushEnabled, state.pushSubscribed, pushSupported, state.settingsLoading);
  const pushButton = button(pushAction.label, "btn btn-small", enablePush);
  pushButton.disabled = pushAction.disabled;
  pushRow.append(pushButton);
  pushCard.append(pushRow);
  container.append(pushCard);
  if (state.pushEnabled === false && !state.settingsLoading) {
    const details = node("details", "tech-note");
    details.append(node("summary", "", t("settings.pushHowto")));
    details.append(
      node("p", "", t("settings.pushHowtoBody")),
      node("code", "", "PAIRFOB_PUSH=1"),
      document.createTextNode(t("settings.pushHowtoTail")),
    );
    container.append(details);
  }
  if (state.pushConfigError) container.append(feedbackNode({ text: state.pushConfigError, tone: "error" }));

  container.append(node("h2", "set-title", t("settings.devices")));
  if (state.settingsLoading && !state.deviceList.length) {
    container.append(feedbackNode({ text: t("settings.devicesLoading"), tone: "status" }));
  } else if (state.devicesError) {
    container.append(feedbackNode({ text: state.devicesError, tone: "error" }));
  } else if (state.deviceList.length) {
    const list = node("div", "set-card device-card");
    state.deviceList.forEach((device) => list.append(deviceRow(device)));
    container.append(list);
    const management = node("details", "tech-note");
    management.append(node("summary", "", t("settings.manageOthers")));
    management.append(
      node("p", "", t("settings.manageOthersBody")),
      node("code", "", "pairfob device revoke <device_id>"),
      document.createTextNode(t("settings.sentenceEnd")),
    );
    container.append(management);
  } else {
    container.append(node("p", "empty-sub", t("settings.noOtherDevices")));
  }

  container.append(node("h2", "set-title", t("settings.danger")));
  const danger = node("div", "set-card");
  const dangerRow = node("div", "set-row set-row-stack");
  dangerRow.append(node("p", "set-note", t("settings.unpairNote")));
  dangerRow.append(button(t("settings.unpair"), "btn btn-small btn-danger", revokeSelf));
  danger.append(dangerRow);
  container.append(danger);

  if (state.devicesError || state.pushConfigError) {
    container.append(button(t("retry"), "btn btn-small btn-ghost retry", refreshSettings));
  }
  const feedback = noteNode();
  if (feedback) container.append(feedback);
}

export function renderSettings(): void {
  const root = node("div", "page settings-page");
  fillSettings(root, true);
  app.replaceChildren(root);
}
