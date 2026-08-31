import { ProtocolError } from "./protocol/errors.ts";

/** Fail-closed copy when a public code has no specific next step. */
export const GENERIC_NOTICE = "出了点问题。刷新页面，或在电脑上运行 pairfob doctor。";

/** User-visible next steps for every public protocol / mux / RPC / enroll code. */
export const FRIENDLY_ERROR: Record<string, string> = {
  unpaired: "配对码过期或已经用过。看电脑 pairfob 打印的当前码。",
  locator_required: "请完整输入电脑上显示的配对码。",
  invalid_pair_code: "配对码格式不对。请按电脑上显示的完整码输入。",
  bad_pair_code: "配对码不正确。请使用电脑 pairfob 打印的新码。",
  pair_timeout: "配对连接超时，请重新扫码或输入当前配对码。",
  pairing_replaced: "另一台电脑开启了配对，请使用最新二维码或配对码。",
  pairing_expired: "电脑上的配对码已经过期，请生成一个新码。",
  sas_required: "已取消配对。请使用电脑 pairfob 打印的新码。",
  pairing_cancelled: "已取消配对。需要时重新扫码或输入配对码。",
  rate_limited: "尝试太频繁，请稍后再试。",
  timeout: "电脑没有及时回应。请先刷新确认当前状态。",
  fp_mismatch: "二维码和这台电脑对不上。请使用电脑当前打印的二维码。",
  bad_relay: "无法连上当前站点。请确认打开的是 pairfob.com，然后刷新。",
  pair_busy: "电脑正在处理另一次配对。请等当前这次结束，或重新运行 pairfob pair。",
  invalid_pair_ref: "这个配对二维码已经失效。请使用电脑当前打印的码。",

  daemon_offline: "电脑现在不在线。若刚合盖，电脑可能已经睡眠。醒来或打开 pairfob 后会自动重连，不用重新配对。也可运行 pairfob doctor。",
  ws_open_failed: "暂时连不上 Pairfob。请检查网络后重试。",
  revoked: "这台手机已被解除配对。请在电脑上重新运行 pairfob pair。",
  herdr_offline: "电脑上的 Herdr 现在没开。打开后会自动恢复。",
  kicked: "另一个窗口接管了这台手机。请只保留一个打开的 Pairfob 页。",
  too_many_devices: "已配对设备太多。在电脑上用 pairfob list / forget 腾出位置后再试。",
  unbound: "还没有连上电脑。请刷新，仍不行就重新配对。",
  wrong_ws: "连接类型不对。请刷新页面。",
  enroll_required: "这台电脑还没有完成安装。请在电脑上重新运行安装脚本。",
  index_unavailable: "暂时找不到这台电脑。请稍后刷新，或在电脑上运行 pairfob doctor。",
  daemon_replaced: "电脑刚刚重新联网，正在自动恢复会话，请稍等。",
  reconnecting: "正在重新连接，网络恢复后会自动继续，请稍等。",
  disconnected: "连接已断开，正在自动恢复，请稍等。",

  pane_not_found: "这个会话已经不在了。回列表再打开。",
  tab_not_found: "这个标签页已经不在了。回列表再打开。",
  workspace_not_found: "这个工作区已经不在了。回列表再打开。",
  stale_prompt: "画面已经变了，没有发送。请先看当前画面再试。",
  invalid_key: "这个按键现在不能用。请先看当前画面。",
  unknown_outcome: "电脑可能已经执行了操作。请先刷新确认，不要立即重试。",
  partial_failure: "操作只完成了一部分，请查看当前会话状态，不要立即重试。",
  conflict: "画面已经变化，请刷新后再试。",
  unsupported: "当前 Herdr 版本还不支持这个操作。请在电脑上升级 Herdr 后再试。",
  agent_not_found: "这个 Agent 已经不在了。回列表再打开。",
  worktree_not_found: "这个 Worktree 已经不在了。回列表再打开。",
  transcript_unavailable: "这个会话暂时没有可读取的历史。请刷新后再试。",
  forbidden: "这次操作不被允许。请刷新确认当前状态。",
  invalid_argument: "这次操作的参数无效。请刷新后按当前画面再试。",
  unknown_op: "当前版本不支持这个操作。请刷新页面，或在电脑上运行 pairfob doctor。",
  too_large: "这次内容太大，没有发送。请缩短后再试。",
  backpressure: "请求太多。请稍后再试。",
  replay: "这次操作已经处理过。请刷新确认当前状态，不要立即重试。",

  bad_token: "连接凭证无效。请刷新；仍不行就重新配对。",
  bad_frame: "连接异常。请刷新页面。",
  bad_message: "电脑返回的数据无法使用。请刷新页面。",
  internal: "电脑处理失败。请刷新，或在电脑上运行 pairfob doctor。",
  bad_proof: "设备凭证无效。请重新配对。",
  bad_signature: "设备凭证无效。请重新配对。",
  invalid_credential: "这台手机的配对数据无效。请重新配对。",

  bad_grant: "电脑登记被拒绝。请在电脑上重新运行安装脚本。",
  grant_exhausted: "电脑现在不能这样登记。请在电脑上重新运行安装脚本，或运行 pairfob doctor。",
};

export function noticeFor(code: string): string {
  if (!code) return GENERIC_NOTICE;
  return FRIENDLY_ERROR[code] || GENERIC_NOTICE;
}

export function messageOf(error: unknown, context: "mutation" | "read" = "mutation"): string {
  if (error instanceof ProtocolError) {
    if (context === "read" && error.code === "too_large") {
      return "这段会话内容较多，暂时没能完整读取。已保留当前内容，请刷新后再试。";
    }
    return noticeFor(error.code);
  }
  return GENERIC_NOTICE;
}

/** Live session chrome copy. Never surfaces mux ERROR.message. */
export function sessionEventNotice(event: { type: string; code?: string; message?: string }): string {
  if (event.type === "connected" || event.type === "poke") return "";
  if (event.code) return noticeFor(event.code);
  if (event.type === "reconnecting") return FRIENDLY_ERROR.reconnecting;
  if (event.type === "disconnected") return FRIENDLY_ERROR.disconnected;
  return GENERIC_NOTICE;
}
