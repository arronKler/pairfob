import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { type DeviceSummary } from "../lib/protocol/client";
import { formatDeviceAge, notificationAction, shortDeviceId, TERM_MODE_LABEL, visiblePairedDevices } from "../lib/ui-model";
import { NETWORK_MODE_OPTIONS, type NetworkMode } from "../lib/network-mode";
import { TERM_MODE_OPTIONS } from "../lib/terminal-mode";
import { openComputers } from "../computers";
import { computerTitle } from "../lib/computer-catalog";
import { revokeDevice, revokeSelf } from "../live-operations";
import { enablePush, refreshSettings, selectNetworkMode } from "../live-settings";
import { render } from "../paint";
import { app, setDefaultTermMode, state } from "../state";
import { isDesk } from "../viewport";
import { composeLiveControl } from "./session-view";
import { appendNotice, backBar, feedbackNode, herdStatus, languageControl, listGroupControl, setHeading, setNavRow, setRow } from "./chrome";

const NETWORK_MODE_COPY: Record<NetworkMode, "settings.networkAuto" | "settings.networkP2P" | "settings.networkRelay"> = {
  auto: "settings.networkAuto",
  p2p: "settings.networkP2P",
  relay: "settings.networkRelay",
};

function networkModeControl(): HTMLElement {
  const bar = node("div", "seg");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", t("settings.networkAria"));
  if (state.transportSwitching) bar.setAttribute("aria-busy", "true");
  for (const id of NETWORK_MODE_OPTIONS) {
    const selected = state.networkMode === id;
    const item = button(t(NETWORK_MODE_COPY[id]), `seg-item${selected ? " on" : ""}`, () => {
      void selectNetworkMode(id);
    });
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    item.disabled = id === "p2p" && !state.p2pEnabled;
    bar.append(item);
  }
  return bar;
}

function networkPathCopy(): string {
  if (state.sessionTransport === "p2p") {
    return state.relayRttMs === null
      ? t("settings.networkP2PPending")
      : t("settings.networkRttP2P", { ms: state.relayRttMs });
  }
  if (state.p2pEnabled && state.networkMode === "p2p") {
    return state.relayRttMs === null
      ? t("settings.networkP2PRelayPending")
      : t("settings.networkP2PRelay", { ms: state.relayRttMs });
  }
  return state.relayRttMs === null
    ? t("settings.networkRelayPending")
    : t("settings.networkRttRelay", { ms: state.relayRttMs });
}

function networkHelpCopy(): string {
  if (state.networkMode === "p2p") return t("settings.networkP2PNote");
  return t("settings.networkNote");
}

function helpWithCode(before: string, code: string, after: string): HTMLParagraphElement {
  const copy = node("p", "help-copy");
  copy.append(document.createTextNode(before), node("code", "", code), document.createTextNode(after));
  return copy;
}

function networkP2PFailCopy(): string {
  if (!state.p2pEnabled || state.networkMode === "relay" || state.sessionTransport === "p2p") return "";
  const attempt = state.lastP2PAttempt;
  if (!attempt || attempt.result !== "failed") return "";
  switch (attempt.extra) {
    case "ice_timeout":
    case "ice_failed":
    case "offer":
      return t("settings.networkP2PFailedICE");
    case "channel_timeout":
    case "channel_failed":
      return t("settings.networkP2PFailedChannel");
    case "signal":
    case "answer":
      return t("settings.networkP2PFailedSignal");
    case "handshake":
    case "commit":
    case "probe":
      return t("settings.networkP2PFailedVerify");
    default:
      return t("settings.networkP2PFailed");
  }
}

function labeledStack(label: string, control: HTMLElement): HTMLElement {
  const row = node("div", "set-row set-row-stack set-field");
  row.append(node("span", "set-key", label), control);
  return row;
}

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
  const body = node("div", "device-body");
  const head = node("div", "device-head");
  const name = device.label || t("device.unnamed");
  head.append(node("strong", "device-name", name));
  if (device.self) head.append(node("span", "pill pill-live", t("device.self")));
  else if (device.connected === true) head.append(node("span", "pill pill-live", t("device.connected")));
  else if (device.connected === false) head.append(node("span", "pill pill-idle", t("device.offline")));
  const id = node("code", "device-id", shortDeviceId(device.device_id));
  id.title = device.device_id;
  const activity = t("device.lastUsed", { when: formatDeviceAge(device.last_seen || device.created_at) });
  const notifications = device.subscription_count ? t("device.notifyOn") : t("device.notifyOff");
  body.append(head, id, node("p", "device-meta", activity + notifications));
  row.append(body);
  if (!device.self) {
    const forget = button(t("settings.unpairOther"), "device-forget", () => void revokeDevice(device));
    forget.setAttribute("aria-label", t("settings.unpairOtherAria", { name }));
    forget.disabled = !state.live?.isConnected();
    row.append(forget);
  }
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
  appendNotice(container);
  const status = herdStatus();
  container.append(setHeading(t("settings.connection"), [networkHelpCopy()]));
  const conn = node("div", "set-card");
  conn.append(
    setNavRow(
      t("settings.computer"),
      state.herdHost || (state.credential ? computerTitle(state.credential) : t("settings.currentComputer")),
      openComputers,
    ),
  );
  conn.append(setRow(t("settings.status"), status.text, status.tone));
  conn.append(setRow(t("settings.networkRtt"), networkPathCopy()));
  const networkModeRow = node("div", "set-row set-row-stack network-mode-row");
  const p2pFail = networkP2PFailCopy();
  if (p2pFail) networkModeRow.append(node("p", "set-note network-p2p-fail", p2pFail));
  if (!state.p2pEnabled) networkModeRow.append(node("p", "set-note", t("settings.networkP2POff")));
  networkModeRow.append(networkModeControl());
  conn.append(networkModeRow);
  const self = state.deviceList.find((device) => device.self && !device.revoked_at);
  if (self) conn.append(setRow(t("settings.thisPhone"), self.label || t("settings.pairedPhone")));
  container.append(conn);

  container.append(setHeading(t("settings.language"), [t("settings.languageNote")]));
  const langCard = node("div", "set-card");
  const langRow = node("div", "set-row");
  langRow.append(languageControl());
  langCard.append(langRow);
  container.append(langCard);

  container.append(setHeading(t("settings.list"), [t("settings.listNote")]));
  const listCard = node("div", "set-card");
  const listRow = node("div", "set-row");
  listRow.append(listGroupControl());
  listCard.append(listRow);
  container.append(listCard);

  container.append(setHeading(t("settings.defaults"), [t("settings.modeNote"), t("settings.inputNote")]));
  const defaultsCard = node("div", "set-card");
  defaultsCard.append(labeledStack(t("settings.mode"), defaultTermModeControl()));
  defaultsCard.append(labeledStack(t("settings.input"), composeLiveControl()));
  container.append(defaultsCard);

  const notifyHelp = state.pushEnabled === false && !state.settingsLoading
    ? [helpWithCode(t("settings.pushHowtoBody"), "PAIRFOB_PUSH=1", t("settings.pushHowtoTail"))]
    : undefined;
  container.append(setHeading(t("settings.notifications"), notifyHelp));
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
  if (state.pushConfigError) container.append(feedbackNode({ text: state.pushConfigError, tone: "error" }));

  const devices = visiblePairedDevices(state.deviceList);
  const deviceHelp = devices.some((device) => !device.self)
    ? [helpWithCode(t("settings.manageOthersBody"), "pairfob forget N", t("settings.sentenceEnd"))]
    : undefined;
  container.append(setHeading(t("settings.devices"), deviceHelp));
  if (state.settingsLoading && !devices.length) {
    container.append(feedbackNode({ text: t("settings.devicesLoading"), tone: "status" }));
  } else if (state.devicesError) {
    container.append(feedbackNode({ text: state.devicesError, tone: "error" }));
  } else if (devices.length) {
    const list = node("div", "set-card device-card");
    devices.forEach((device) => list.append(deviceRow(device)));
    container.append(list);
  } else {
    container.append(node("p", "empty-sub", t("settings.noOtherDevices")));
  }

  container.append(setHeading(t("settings.danger")));
  const danger = node("div", "set-card");
  const dangerRow = node("div", "set-row set-row-stack");
  dangerRow.append(node("p", "set-note", t("settings.unpairNote")));
  dangerRow.append(button(t("settings.unpair"), "btn btn-small btn-danger", revokeSelf));
  danger.append(dangerRow);
  container.append(danger);

  if (state.devicesError || state.pushConfigError) {
    container.append(button(t("retry"), "btn btn-small btn-ghost retry", refreshSettings));
  }
}

export function renderSettings(): void {
  const root = node("div", "page settings-page");
  fillSettings(root, true);
  app.replaceChildren(root);
}
