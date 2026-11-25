#!/usr/bin/env bun
// Render the 22-second README hero GIFs (site/img/readme/demo-{en,zh}.gif)
// showing the full loop including BOTH Chat mode and True PTY Terminal keypad:
//   1. pairfob pair -> QR scan
//   2. "Needs you" alert -> Chat mode prompt reply
//   3. Switch to True PTY Terminal -> touch keypad (arrows + Enter) approves TUI prompt
//   4. Review diff & send inline line comment
//   5. Computer agent applies note & finishes live in Chat
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const HOME_IMG = join(ROOT, "site", "img", "home");
const README_OUT = join(ROOT, "site", "img", "readme");
const CDP_PORT = Number(process.env.DEMO_GIF_CDP_PORT ?? 9339);
const WIDTH = 960;
const HEIGHT = 540;
const SCALE = 2;
const FPS = 12;
const DURATION_MS = 22000;
const TOTAL_FRAMES = Math.round((DURATION_MS / 1000) * FPS);

type Lang = "en" | "zh";

const COPY: Record<Lang, {
  caption1: string; caption2: string; caption3: string; caption4: string; caption5: string;
  modeChat: string; modeTerm: string; modeDiff: string;
  cmd: string; scanHint: string; paired: string;
  notifTitle: string; notifBody: string;
  chatMsg: string; chatSend: string;
  termHint: string;
  noteText: string; sendLabel: string;
  resumed: string; passed: string;
  badge: string;
}> = {
  en: {
    caption1: "1. Run pairfob pair & scan once",
    caption2: "2. Reply in Chat mode when an agent needs you",
    caption3: "3. Switch to True PTY Terminal — tap arrows & Enter",
    caption4: "4. Review git diff & send an inline comment",
    caption5: "5. Agent applies note & finishes live (P2P E2EE)",
    modeChat: "Chat",
    modeTerm: "Terminal · PTY",
    modeDiff: "Diff",
    cmd: "pairfob pair",
    scanHint: "Press Enter to pair · iPhone Safari",
    paired: "✓ Paired · WebRTC P2P direct · E2EE",
    notifTitle: "Pairfob · Needs you",
    notifBody: "codex in pairfob is waiting on your input",
    chatMsg: "Run auth tests and check token expiry",
    chatSend: "Send",
    termHint: "Key sent to PTY:",
    noteText: "Check nil expiry before refreshing token",
    sendLabel: "Send to agent",
    resumed: "› Review note on src/app.ts:42 — Check nil expiry before refreshing token",
    passed: "✓ Edited src/app.ts (+6 −2) · 18 tests passed (1.4s)",
    badge: "pairfob.com · No VPN · No account",
  },
  zh: {
    caption1: "1. 终端运行 pairfob pair，手机一扫即连",
    caption2: "2. 收到「需要你」提醒，在对话模式直接发指令",
    caption3: "3. 一键切真 PTY 终端：方向键与 Enter 实操 TUI",
    caption4: "4. 手机看 Diff，点一行直接写行级批注",
    caption5: "5. 电脑端 Agent 自动继续并完成（P2P 端到端加密）",
    modeChat: "对话模式",
    modeTerm: "真 PTY 终端",
    modeDiff: "Diff 审查",
    cmd: "pairfob pair",
    scanHint: "按 Enter 确认配对 · iPhone Safari",
    paired: "✓ 已配对 · WebRTC P2P 直连 · 端到端加密",
    notifTitle: "Pairfob · 需要你",
    notifBody: "pairfob 里的 codex 正在等你回复",
    chatMsg: "跑一下 auth 测试并检查 token 过期处理",
    chatSend: "发送",
    termHint: "发送真按键到 PTY：",
    noteText: "刷新 token 前先判断 expiry 是否为空",
    sendLabel: "发给 Agent",
    resumed: "› 收到 src/app.ts:42 批注：刷新 token 前先判断 expiry 是否为空",
    passed: "✓ 已更新 src/app.ts (+6 −2) · 18 项测试全部通过 (1.4s)",
    badge: "pairfob.com · 无需 VPN · 无需账号",
  },
};

function chromePath(): string {
  if (process.env.CHROME) return process.env.CHROME;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

async function waitFor(url: string, what: string): Promise<Response> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch { /* retry */ }
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

class Cdp {
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      const waiter = msg.id ? this.pending.get(msg.id) : undefined;
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    };
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("CDP connect failed")); });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  close(): void { this.ws.close(); }
}

async function dataUri(file: string): Promise<string> {
  const bytes = await Bun.file(file).arrayBuffer();
  return `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function buildHtml(lang: Lang): Promise<string> {
  const c = COPY[lang];
  const img = async (name: string) => dataUri(join(HOME_IMG, lang, `${name}.webp`));
  const [connectImg, listImg, chatImg, termImg, diffImg] = await Promise.all([
    img("connect"), img("home-grouped"), img("chat-complete"), img("guided-expanded"), img("workspace-diff"),
  ]);

  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
    background: #090d14;
    color: #e9edf3;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Display", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .stage {
    position: relative; width: 100%; height: 100%;
    padding: 18px 24px 16px;
    background: #090d14;
    display: flex; flex-direction: column; gap: 13px;
  }
  .top {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .step-pill {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 6px 14px; border-radius: 999px;
    background: rgba(18, 24, 34, 0.92);
    border: 1px solid rgba(110, 168, 254, 0.36);
    font-size: 13px; font-weight: 600; color: #dbe9ff;
    white-space: nowrap;
  }
  .step-dot {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
    background: #46d68c; box-shadow: 0 0 0 4px rgba(70, 214, 140, 0.2);
  }
  .mode-switch {
    display: inline-flex; align-items: center; gap: 3px; padding: 3px;
    border-radius: 999px; background: rgba(16, 21, 30, 0.92);
    border: 1px solid rgba(233, 237, 243, 0.12);
    font-size: 11.5px; font-weight: 600;
  }
  .mode-switch span {
    padding: 4px 10px; border-radius: 999px; color: #7e8b9d;
  }
  .mode-switch span.on {
    background: #2563d9; color: #fff;
  }
  .canvas {
    flex: 1; display: grid; grid-template-columns: 1fr 248px; gap: 22px; align-items: center;
    min-height: 0;
  }
  /* Mac terminal */
  .term {
    height: 426px; border-radius: 16px; overflow: hidden;
    background: #0d1118;
    border: 1px solid rgba(233, 237, 243, 0.11);
    box-shadow: 0 28px 60px rgba(0, 0, 0, 0.55);
    display: flex; flex-direction: column;
  }
  .term-bar {
    height: 34px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between;
    background: #131924; border-bottom: 1px solid rgba(233, 237, 243, 0.08);
    font-size: 12px; color: #9aa5b4;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .term-bar-l { display: inline-flex; align-items: center; gap: 10px; }
  .dots { display: inline-flex; gap: 6px; }
  .dots i { width: 10px; height: 10px; border-radius: 50%; display: block; }
  .dots i:nth-child(1) { background: #ff5f57; }
  .dots i:nth-child(2) { background: #febc2e; }
  .dots i:nth-child(3) { background: #28c840; }
  .term-body {
    flex: 1; padding: 15px 18px;
    font: 12.8px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
    color: #dbe3ee; display: flex; flex-direction: column; gap: 6px;
  }
  .dim { color: #7b8798; }
  .acc { color: #6ea8fe; }
  .ok { color: #46d68c; font-weight: 600; }
  .warn { color: #ffb224; font-weight: 600; }
  .qr-row {
    display: flex; gap: 16px; align-items: center;
    padding: 10px 12px; margin: 4px 0; border-radius: 10px;
    background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(233, 237, 243, 0.08);
  }
  .qr-box {
    width: 88px; height: 88px; padding: 6px; border-radius: 8px; background: #fff; flex: none;
    display: grid; grid-template-columns: repeat(9, 1fr); gap: 1px;
  }
  .qr-box span { background: #fff; }
  .qr-box span.b { background: #0b0e13; }
  .code-pill {
    display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 6px;
    background: rgba(110, 168, 254, 0.14); color: #9cc4ff; font-weight: 600;
  }
  .tui-box {
    margin-top: 4px; padding: 10px 12px; border-radius: 10px;
    background: rgba(110, 168, 254, 0.07); border: 1px solid rgba(110, 168, 254, 0.28);
  }
  .tui-opt { padding: 1px 6px; border-radius: 5px; color: #8c98aa; }
  .tui-opt.sel { background: rgba(110, 168, 254, 0.22); color: #fff; font-weight: 600; }
  .key-badge {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 4px;
    padding: 3px 10px; border-radius: 999px; width: fit-content;
    background: rgba(70, 214, 140, 0.14); border: 1px solid rgba(70, 214, 140, 0.35);
    color: #9ff3c7; font-size: 11.5px;
  }
  .key-badge kbd {
    padding: 1px 6px; border-radius: 4px; background: #162230; color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.2); font-family: inherit; font-weight: 700;
  }
  .cursor {
    display: inline-block; width: 7px; height: 14px; background: #6ea8fe;
    vertical-align: -2px; margin-left: 2px;
  }
  /* Phone */
  .phone {
    position: relative; width: 236px; height: 458px; padding: 7px; border-radius: 34px;
    background: #1b222e;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14);
    justify-self: center;
  }
  .screen {
    position: relative; width: 100%; height: 100%; border-radius: 27px; overflow: hidden;
    background: #0a0c10;
  }
  .screen img {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: top;
    opacity: 0;
  }
  .notif {
    position: absolute; left: 8px; right: 8px; top: 10px; z-index: 10;
    padding: 9px 11px; border-radius: 14px;
    background: rgba(20, 26, 36, 0.96);
    border: 1px solid rgba(255, 178, 36, 0.55);
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.55);
    opacity: 0; transform: translateY(-20px);
  }
  .notif b { display: block; font-size: 11px; color: #ffb224; margin-bottom: 2px; }
  .notif span { display: block; font-size: 10.5px; color: #e2e8f0; line-height: 1.35; }
  .chat-compose {
    position: absolute; left: 8px; right: 8px; bottom: 10px; z-index: 12;
    padding: 8px 9px; border-radius: 14px;
    background: rgba(15, 20, 29, 0.97);
    border: 1px solid rgba(110, 168, 254, 0.55);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.65);
    display: flex; align-items: center; gap: 7px;
    opacity: 0; transform: translateY(14px);
  }
  .chat-input {
    flex: 1; font-size: 10.5px; color: #f1f5f9; line-height: 1.35; min-height: 16px;
  }
  .chat-send {
    flex: none; padding: 4px 9px; border-radius: 999px;
    background: #2563d9; color: #fff; font-size: 10px; font-weight: 700;
  }
  .comment-card {
    position: absolute; left: 8px; right: 8px; bottom: 12px; z-index: 12;
    padding: 10px; border-radius: 14px;
    background: rgba(15, 20, 29, 0.97);
    border: 1px solid rgba(110, 168, 254, 0.55);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.65);
    opacity: 0; transform: translateY(18px);
  }
  .comment-line {
    font: 600 10px ui-monospace, "SF Mono", Menlo, monospace; color: #8bbbff; margin-bottom: 5px;
  }
  .comment-input {
    min-height: 30px; padding: 6px 8px; border-radius: 8px;
    background: #0a0d13; border: 1px solid rgba(233, 237, 243, 0.14);
    font-size: 10.5px; color: #f1f5f9; line-height: 1.35; margin-bottom: 7px;
  }
  .comment-btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 4px 10px; border-radius: 999px; background: #2563d9; color: #fff;
    font-size: 10.5px; font-weight: 600; float: right;
  }
  .tap {
    position: absolute; width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid #6ea8fe; background: rgba(110, 168, 254, 0.34);
    transform: translate(-50%, -50%) scale(0.4); opacity: 0; z-index: 20; pointer-events: none;
  }
  .progress {
    height: 3px; border-radius: 3px; background: rgba(255, 255, 255, 0.08); overflow: hidden;
  }
  .progress > i {
    display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #3b82f6, #46d68c);
  }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="stage">
  <div class="top">
    <div class="step-pill"><span class="step-dot"></span><span id="caption">${c.caption1}</span></div>
    <div class="mode-switch" id="mode-switch">
      <span id="m-chat">${c.modeChat}</span>
      <span id="m-term">${c.modeTerm}</span>
      <span id="m-diff">${c.modeDiff}</span>
    </div>
  </div>
  <div class="canvas">
    <div class="term">
      <div class="term-bar">
        <span class="term-bar-l"><span class="dots"><i></i><i></i><i></i></span><span>MacBook Pro — ~/work/pairfob</span></span>
        <span class="dim">${c.badge}</span>
      </div>
      <div class="term-body">
        <div id="act-pair">
          <p><span class="acc">$</span> <span id="typed-cmd"></span><span class="cursor" id="cmd-cur"></span></p>
          <div class="qr-row hidden" id="qr-row">
            <div class="qr-box" id="qr-grid"></div>
            <div>
              <p class="dim">Scan at pairfob.com/pair</p>
              <span class="code-pill">K7QF-3M9D-a8</span>
              <p class="dim" style="margin-top:6px" id="pair-status">Waiting for phone…</p>
            </div>
          </div>
          <p class="ok hidden" id="paired-line">${c.paired}</p>
        </div>

        <div id="act-live" class="hidden">
          <p class="dim">~/work/pairfob · feat/auth · claude-code / codex</p>
          <p class="hidden" id="chat-arrived"><span class="acc">›</span> ${c.chatMsg}</p>
          <div class="tui-box hidden" id="tui-box">
            <p class="warn">⏸ Needs you — run command?</p>
            <p class="dim">$ go test ./internal/auth/...</p>
            <p class="tui-opt sel" id="opt-1">› 1. Yes, proceed</p>
            <p class="tui-opt" id="opt-2">&nbsp; 2. No, tell Codex what to do differently</p>
          </div>
          <div class="key-badge hidden" id="key-badge"><span>${c.termHint}</span><kbd id="key-val">Enter</kbd></div>
          <p class="dim hidden" id="test-ran">• Edited src/app.ts (+14 −5) · waiting on diff review</p>
          <p class="hidden" id="note-received"><span class="acc">${c.resumed}</span></p>
          <p class="dim hidden" id="agent-working">• Applying review comment &amp; re-running suite…</p>
          <p class="ok hidden" id="agent-done">${c.passed}</p>
          <p class="hidden" id="agent-prompt"><span class="acc">›</span> <span class="cursor"></span></p>
        </div>
      </div>
    </div>

    <div class="phone">
      <div class="screen">
        <img id="s-connect" src="${connectImg}" />
        <img id="s-list" src="${listImg}" />
        <img id="s-chat" src="${chatImg}" />
        <img id="s-term" src="${termImg}" />
        <img id="s-diff" src="${diffImg}" />
        <div class="notif" id="notif">
          <b>${c.notifTitle}</b>
          <span>${c.notifBody}</span>
        </div>
        <div class="chat-compose" id="chat-compose">
          <div class="chat-input" id="chat-input"></div>
          <span class="chat-send" id="chat-send">${c.chatSend}</span>
        </div>
        <div class="comment-card" id="comment-card">
          <div class="comment-line">src/app.ts · L42</div>
          <div class="comment-input" id="note-input"></div>
          <span class="comment-btn" id="send-btn">${c.sendLabel}</span>
        </div>
        <div class="tap" id="tap"></div>
      </div>
    </div>
  </div>
  <div class="progress"><i id="prog"></i></div>
</div>
<script>
  const COPY = ${JSON.stringify(c)};
  const qr = document.getElementById("qr-grid");
  const pat = [
    "111010111","101001101","111010111",
    "000101000","101110101","010011010",
    "111010011","101001100","111011011"
  ];
  for (const row of pat) for (const ch of row) {
    const s = document.createElement("span");
    if (ch === "1") s.className = "b";
    qr.append(s);
  }

  const el = (id) => document.getElementById(id);
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  function showImg(id) {
    for (const k of ["s-connect", "s-list", "s-chat", "s-term", "s-diff"]) {
      el(k).style.opacity = k === id ? "1" : "0";
    }
  }

  function setMode(active) {
    for (const k of ["m-chat", "m-term", "m-diff"]) {
      el(k).classList.toggle("on", k === active);
    }
  }

  function showTap(x, y, p) {
    const tap = el("tap");
    if (p <= 0 || p >= 1) { tap.style.opacity = "0"; return; }
    tap.style.left = x + "px";
    tap.style.top = y + "px";
    tap.style.opacity = String(1 - p);
    tap.style.transform = "translate(-50%, -50%) scale(" + (0.5 + p * 0.9) + ")";
  }

  window.__seek = (ms) => {
    el("prog").style.width = ((ms / ${DURATION_MS}) * 100).toFixed(2) + "%";
    const cap = el("caption");
    const actPair = el("act-pair");
    const actLive = el("act-live");
    const notif = el("notif");
    const chatBox = el("chat-compose");
    const card = el("comment-card");
    const keyBadge = el("key-badge");
    showTap(0, 0, 0);
    notif.style.opacity = "0";
    chatBox.style.opacity = "0";
    card.style.opacity = "0";
    keyBadge.classList.add("hidden");

    // Act 1: 0..3800ms — pairfob pair + QR scan
    if (ms < 3800) {
      cap.textContent = COPY.caption1;
      setMode("");
      actPair.classList.remove("hidden");
      actLive.classList.add("hidden");
      const chars = Math.min(COPY.cmd.length, Math.floor((ms / 900) * COPY.cmd.length));
      el("typed-cmd").textContent = COPY.cmd.slice(0, chars);
      el("cmd-cur").style.opacity = ms < 1050 ? "1" : "0";
      el("qr-row").classList.toggle("hidden", ms < 1100);
      el("pair-status").textContent = ms >= 2100 ? COPY.scanHint : "Waiting for phone…";
      el("paired-line").classList.toggle("hidden", ms < 2800);
      showImg(ms < 2900 ? "s-connect" : "s-list");
      return;
    }

    actPair.classList.add("hidden");
    actLive.classList.remove("hidden");

    // Act 2: 3800..8800ms — Needs you notification -> Chat mode reply
    if (ms < 8800) {
      cap.textContent = COPY.caption2;
      setMode("m-chat");
      el("tui-box").classList.add("hidden");
      el("test-ran").classList.add("hidden");
      el("note-received").classList.add("hidden");
      el("agent-working").classList.add("hidden");
      el("agent-done").classList.add("hidden");
      el("agent-prompt").classList.add("hidden");

      if (ms < 5400) {
        showImg("s-list");
        el("chat-arrived").classList.add("hidden");
        const np = clamp((ms - 3950) / 300);
        const out = ms > 5050 ? clamp((ms - 5050) / 250) : 0;
        const vis = np * (1 - out);
        notif.style.opacity = String(vis);
        notif.style.transform = "translateY(" + ((1 - vis) * -18).toFixed(1) + "px)";
        if (ms >= 4750 && ms <= 5300) showTap(112, 34, (ms - 4750) / 550);
      } else {
        showImg("s-chat");
        const cp = clamp((ms - 5500) / 280);
        chatBox.style.opacity = String(cp);
        chatBox.style.transform = "translateY(" + ((1 - cp) * 14).toFixed(1) + "px)";
        const typed = Math.min(COPY.chatMsg.length, Math.max(0, Math.floor(((ms - 5750) / 1850) * COPY.chatMsg.length)));
        el("chat-input").textContent = COPY.chatMsg.slice(0, typed);
        if (ms >= 7800 && ms <= 8350) {
          showTap(182, 418, (ms - 7800) / 550);
          el("chat-send").style.background = "#1d4ed8";
        } else {
          el("chat-send").style.background = "#2563d9";
        }
        el("chat-arrived").classList.toggle("hidden", ms < 8150);
      }
      return;
    }

    // Act 3: 8800..13600ms — True PTY Terminal + touch keypad (arrows & Enter)
    el("chat-arrived").classList.remove("hidden");
    el("tui-box").classList.remove("hidden");
    if (ms < 13600) {
      cap.textContent = COPY.caption3;
      setMode("m-term");
      showImg("s-term");
      el("note-received").classList.add("hidden");
      el("agent-working").classList.add("hidden");
      el("agent-done").classList.add("hidden");
      el("agent-prompt").classList.add("hidden");

      // Sequence of real PTY key taps on guided-expanded keypad (222x444 screen):
      // 9500..10100: tap Down arrow (82, 424) -> moves to opt 2
      // 10600..11200: tap Up arrow (55, 424) -> moves back to opt 1
      // 11800..12400: tap Enter (196, 354) -> confirms command!
      const onOpt2 = ms >= 9750 && ms < 10850;
      el("opt-1").classList.toggle("sel", !onOpt2);
      el("opt-2").classList.toggle("sel", onOpt2);
      el("opt-1").textContent = (!onOpt2 ? "› " : "  ") + "1. Yes, proceed";
      el("opt-2").textContent = (onOpt2 ? "› " : "  ") + "2. No, tell Codex what to do differently";

      if (ms >= 9500 && ms <= 10100) {
        showTap(82, 424, (ms - 9500) / 600);
        keyBadge.classList.remove("hidden");
        el("key-val").textContent = "↓";
      } else if (ms >= 10600 && ms <= 11200) {
        showTap(55, 424, (ms - 10600) / 600);
        keyBadge.classList.remove("hidden");
        el("key-val").textContent = "↑";
      } else if (ms >= 11800 && ms <= 13500) {
        if (ms <= 12400) showTap(196, 354, (ms - 11800) / 600);
        keyBadge.classList.remove("hidden");
        el("key-val").textContent = "Enter ↵";
      }
      el("test-ran").classList.toggle("hidden", ms < 12450);
      return;
    }

    el("opt-1").classList.add("sel");
    el("opt-2").classList.remove("sel");
    el("opt-1").textContent = "› 1. Yes, proceed";
    el("opt-2").textContent = "  2. No, tell Codex what to do differently";
    el("test-ran").classList.remove("hidden");

    // Act 4: 13600..18000ms — Diff review & inline line comment
    if (ms < 18000) {
      cap.textContent = COPY.caption4;
      setMode("m-diff");
      showImg("s-diff");
      el("note-received").classList.add("hidden");
      el("agent-working").classList.add("hidden");
      el("agent-done").classList.add("hidden");
      el("agent-prompt").classList.add("hidden");

      if (ms >= 13900 && ms <= 14450) showTap(110, 210, (ms - 13900) / 550);
      const cp = clamp((ms - 14400) / 300);
      card.style.opacity = String(cp);
      card.style.transform = "translateY(" + ((1 - cp) * 18).toFixed(1) + "px)";

      const typed = Math.min(COPY.noteText.length, Math.max(0, Math.floor(((ms - 14750) / 2150) * COPY.noteText.length)));
      el("note-input").textContent = COPY.noteText.slice(0, typed);
      if (ms >= 17150 && ms <= 17750) {
        showTap(168, 416, (ms - 17150) / 600);
        el("send-btn").style.background = "#1d4ed8";
      } else {
        el("send-btn").style.background = "#2563d9";
      }
      return;
    }

    // Act 5: 18000..22000ms — Agent applies note & finishes live
    cap.textContent = COPY.caption5;
    setMode("m-chat");
    showImg("s-chat");
    el("note-received").classList.remove("hidden");
    el("agent-working").classList.toggle("hidden", ms < 18750);
    el("agent-done").classList.toggle("hidden", ms < 19750);
    el("agent-prompt").classList.toggle("hidden", ms < 20250);
  };
  window.__seek(0);
</script>
</body>
</html>`;
}

async function renderLang(cdp: Cdp, lang: Lang): Promise<void> {
  const framesDir = await mkdtemp(join(tmpdir(), `pairfob-gif-${lang}-`));
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
    }, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
    await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: await buildHtml(lang) }, sessionId);
    await cdp.send("Runtime.evaluate", {
      expression: "Promise.all([...document.images].map((img) => img.decode()))",
      awaitPromise: true,
    }, sessionId);

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const ms = Math.round((i / TOTAL_FRAMES) * DURATION_MS);
      await cdp.send("Runtime.evaluate", { expression: `window.__seek(${ms})` }, sessionId);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      await Bun.write(join(framesDir, `f-${String(i).padStart(4, "0")}.png`), Buffer.from(data, "base64"));
    }

    const outGif = join(README_OUT, `demo-${lang}.gif`);
    const palette = join(framesDir, "palette.png");
    const run = async (cmd: string[]) => {
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`${cmd[0]} failed: ${await new Response(proc.stderr).text()}`);
    };
    await run([
      "ffmpeg", "-y", "-framerate", String(FPS), "-i", join(framesDir, "f-%04d.png"),
      "-vf", "palettegen=max_colors=256:stats_mode=diff", palette,
    ]);
    await run([
      "ffmpeg", "-y", "-framerate", String(FPS), "-i", join(framesDir, "f-%04d.png"),
      "-i", palette,
      "-lavfi", "paletteuse=dither=bayer:bayer_scale=1:diff_mode=rectangle",
      "-loop", "0", outGif,
    ]);
    const sizeKB = Math.round((await Bun.file(outGif).size) / 1024);
    console.log(`wrote ${outGif.slice(ROOT.length + 1)} (${sizeKB} KB)`);
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
    await rm(framesDir, { recursive: true, force: true });
  }
}

await mkdir(README_OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "pairfob-gif-chrome-"));
const chrome = Bun.spawn([
  chromePath(),
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-proxy-server", "about:blank",
], { stdout: "ignore", stderr: "ignore" });

let cdp: Cdp | undefined;
try {
  const version = await (await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, "Chrome")).json();
  cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  await renderLang(cdp, "en");
  await renderLang(cdp, "zh");
} finally {
  cdp?.close();
  chrome.kill();
  await rm(profile, { recursive: true, force: true });
}
