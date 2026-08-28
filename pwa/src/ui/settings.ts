import { button, node } from "../lib/dom";
import { type DeviceSummary } from "../lib/protocol/client";
import { formatDeviceAge, notificationAction, shortDeviceId, TERM_MODE_LABEL } from "../lib/ui-model";
import { beginAddComputer, openComputers } from "../computers";
import { computerTitle } from "../lib/computer-catalog";
import { enablePush, refreshSettings, revokeSelf } from "../live";
import { render } from "../paint";
import { app, setDefaultTermMode, state, type TermMode } from "../state";
import { isDesk } from "../viewport";
import { composeLiveControl } from "./session-view";
import { backBar, feedbackNode, herdStatus, listGroupControl, noteNode, setRow } from "./chrome";

const TERM_MODE_OPTIONS: Array<{ id: TermMode; label: string }> = [
  { id: "guided", label: TERM_MODE_LABEL.guided },
  { id: "full", label: TERM_MODE_LABEL.full },
  { id: "agent", label: TERM_MODE_LABEL.agent },
];

function defaultTermModeControl(): HTMLElement {
  const bar = node("div", "seg");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", "默认模式");
  for (const option of TERM_MODE_OPTIONS) {
    const selected = state.defaultTermMode === option.id;
    const item = button(option.label, `seg-item${selected ? " on" : ""}`, () => {
      if (state.defaultTermMode === option.id) return;
      setDefaultTermMode(option.id);
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
  head.append(node("strong", "device-name", device.label || "未命名设备"));
  if (device.self) head.append(node("span", "pill pill-live", "这台手机"));
  if (device.revoked_at) head.append(node("span", "pill pill-off", "已解除配对"));
  const id = node("code", "device-id", shortDeviceId(device.device_id));
  id.title = device.device_id;
  const activity = device.revoked_at
    ? `解除配对：${formatDeviceAge(device.revoked_at)}`
    : `最近使用：${formatDeviceAge(device.last_seen || device.created_at)}`;
  const notifications = device.subscription_count ? " · 通知已开启" : " · 未开启通知";
  row.append(head, id, node("p", "device-meta", activity + notifications));
  return row;
}

export function fillSettings(container: HTMLElement | DocumentFragment, withBack: boolean): void {
  if (withBack) {
    container.append(
      backBar("设置", () => {
        state.screen = isDesk() && state.paneId ? "pane" : "home";
        render();
      }),
    );
  }
  const status = herdStatus();
  container.append(node("h2", "set-title", "连接"));
  const conn = node("div", "set-card");
  conn.append(setRow("电脑", state.herdHost || (state.credential ? computerTitle(state.credential) : "当前电脑")));
  conn.append(setRow("状态", status.text, status.tone));
  const self = state.deviceList.find((device) => device.self && !device.revoked_at);
  if (self) conn.append(setRow("这台手机", self.label || "已配对设备"));
  if (state.computers.length > 1) {
    const switchRow = node("div", "set-row set-row-stack");
    switchRow.append(node("p", "set-note", `这台手机上有 ${state.computers.length} 台已配对电脑。`));
    switchRow.append(button("切换电脑", "btn btn-small", openComputers));
    conn.append(switchRow);
  }
  const addRow = node("div", "set-row set-row-stack");
  addRow.append(
    node(
      "p",
      "set-note",
      "另一台电脑先装 pairfobd（和第一台同一条安装命令），再执行 pairfobd pair。这里扫码只是多一条凭证，不会替换现在这台。",
    ),
  );
  addRow.append(button("添加另一台电脑", "btn btn-small", beginAddComputer));
  conn.append(addRow);
  container.append(conn);

  container.append(node("h2", "set-title", "会话列表"));
  const listCard = node("div", "set-card");
  const listRow = node("div", "set-row set-row-stack");
  listRow.append(node("p", "set-note", "默认平铺全部会话。按工作区或 Agent 分组后，点标题折叠；默认只展开第一组。"));
  listRow.append(listGroupControl());
  listCard.append(listRow);
  container.append(listCard);

  container.append(node("h2", "set-title", "模式"));
  const modeCard = node("div", "set-card");
  const modeRow = node("div", "set-row set-row-stack");
  modeRow.append(
    node(
      "p",
      "set-note",
      "控制是手机上操作这个会话：选项可点，用系统键盘。终端是真终端。对话是和 Agent 发消息。点开会话时默认进这个；某个会话里再切换，只记住那一个。",
    ),
  );
  modeRow.append(defaultTermModeControl());
  modeCard.append(modeRow);
  container.append(modeCard);

  container.append(node("h2", "set-title", "输入"));
  const inputCard = node("div", "set-card");
  const inputRow = node("div", "set-row set-row-stack");
  inputRow.append(
    node("p", "set-note", "组字是写完再发送。实时是边打边进终端，右侧 Enter 再确认。"),
  );
  inputRow.append(composeLiveControl());
  inputCard.append(inputRow);
  container.append(inputCard);

  container.append(node("h2", "set-title", "通知"));
  const pushCard = node("div", "set-card");
  const pushRow = node("div", "set-row set-row-stack");
  pushRow.append(
    node(
      "p",
      "set-note",
      state.pushEnabled === false
        ? "电脑端还没有开启 Pairfob 通知，先在电脑端设置。"
        : state.pushSubscribed === true
          ? "Agent 等你处理或完成任务时，会通知这台手机。"
          : "开启后，Agent 等你处理或完成任务时会通知这台手机。",
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
    details.append(node("summary", "", "电脑端设置方法"));
    details.append(
      node("p", "", "启动 pairfobd 时加入 "),
      node("code", "", "PAIRFOB_PUSH=1"),
      document.createTextNode("，并设置 PAIRFOB_VAPID_SUBJECT，然后重新打开本页。"),
    );
    container.append(details);
  }
  if (state.pushConfigError) container.append(feedbackNode({ text: state.pushConfigError, tone: "error" }));

  container.append(node("h2", "set-title", "已配对设备"));
  if (state.settingsLoading && !state.deviceList.length) {
    container.append(feedbackNode({ text: "正在读取设备列表…", tone: "status" }));
  } else if (state.devicesError) {
    container.append(feedbackNode({ text: state.devicesError, tone: "error" }));
  } else if (state.deviceList.length) {
    const list = node("div", "set-card device-card");
    state.deviceList.forEach((device) => list.append(deviceRow(device)));
    container.append(list);
    const management = node("details", "tech-note");
    management.append(node("summary", "", "管理其他设备"));
    management.append(
      node("p", "", "为防止失窃手机解除其他设备的配对，手机端只能解除自己的配对。请在电脑端运行 "),
      node("code", "", "pairfobd device revoke <device_id>"),
      document.createTextNode("。"),
    );
    container.append(management);
  } else {
    container.append(node("p", "empty-sub", "还没有其他已配对设备。"));
  }

  container.append(node("h2", "set-title", "危险操作"));
  const danger = node("div", "set-card");
  const dangerRow = node("div", "set-row set-row-stack");
  dangerRow.append(node("p", "set-note", "解除后，这台手机会立即断开并删除本地凭证。"));
  dangerRow.append(button("解除这台手机的配对", "btn btn-small btn-danger", revokeSelf));
  danger.append(dangerRow);
  container.append(danger);

  if (state.devicesError || state.pushConfigError) {
    container.append(button("重试", "btn btn-small btn-ghost retry", refreshSettings));
  }
  const feedback = noteNode();
  if (feedback) container.append(feedback);
}

export function renderSettings(): void {
  const root = node("div", "page settings-page");
  fillSettings(root, true);
  app.replaceChildren(root);
}
