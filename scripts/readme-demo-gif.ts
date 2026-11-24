#!/usr/bin/env bun
// Render the 18-second README hero GIFs (site/img/readme/demo-{en,zh}.gif)
// showing the full loop:
//   pairfob pair -> QR scan -> "Needs you" notice -> diff line comment -> agent resumes.
// Uses headless Chrome with deterministic frame stepping over the real PWA stills
// in site/img/home/{en,zh}/ and encodes a crisp, compact GIF via ffmpeg palettegen.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const HOME_IMG = join(ROOT, "site", "img", "home");
const README_OUT = join(ROOT, "site", "img", "readme");
const CDP_PORT = Number(process.env.DEMO_GIF_CDP_PORT ?? 9339);
const WIDTH = 920;
const HEIGHT = 540;
const FPS = 14;
const DURATION_MS = 18000;
const TOTAL_FRAMES = Math.round((DURATION_MS / 1000) * FPS);

type Lang = "en" | "zh";

const COPY: Record<Lang, {
  caption1: string; caption2: string; caption3: string; caption4: string;
  cmd: string; scanHint: string; paired: string;
  notifTitle: string; notifBody: string;
  noteText: string; sendLabel: string;
  resumed: string; passed: string;
  badge: string;
}> = {
  en: {
    caption1: "1. Run pairfob pair & scan once",
    caption2: "2. Get notified when an agent needs you",
    caption3: "3. Review diff & send a line comment",
    caption4: "4. Computer agent resumes live (P2P E2EE)",
    cmd: "pairfob pair",
    scanHint: "Press Enter to pair · iPhone Safari",
    paired: "✓ Paired · WebRTC P2P direct · E2EE",
    notifTitle: "Pairfob · Needs you",
    notifBody: "codex in pairfob is waiting on your review",
    noteText: "Check nil expiry before refreshing token",
    sendLabel: "Send to agent",
    resumed: "› Review note on src/app.ts:42 — Check nil expiry before refreshing token",
    passed: "✓ Edited src/app.ts (+6 −2) · 18 tests passed (1.4s)",
    badge: "pairfob.com · No VPN · No account",
  },
  zh: {
    caption1: "1. 终端运行 pairfob pair，手机一扫即连",
    caption2: "2. Agent 卡住时，手机立刻收到「需要你」提醒",
    caption3: "3. 在手机上看 Diff，点一行直接写批注发回",
    caption4: "4. 电脑端 Agent 自动继续执行（P2P 端到端加密）",
    cmd: "pairfob pair",
    scanHint: "按 Enter 确认配对 · iPhone Safari",
    paired: "✓ 已配对 · WebRTC P2P 直连 · 端到端加密",
    notifTitle: "Pairfob · 需要你",
    notifBody: "pairfob 里的 codex 正在等你审查改动",
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
  const [connectImg, listImg, diffImg, chatImg] = await Promise.all([
    img("connect"), img("home-grouped"), img("workspace-diff"), img("chat-complete"),
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
    padding: 20px 26px 18px;
    background:
      radial-gradient(560px 360px at 82% 18%, rgba(61, 123, 253, 0.22), transparent 70%),
      radial-gradient(480px 320px at 14% 92%, rgba(70, 214, 140, 0.12), transparent 70%),
      #090d14;
    display: flex; flex-direction: column; gap: 14px;
  }
  .top {
    display: flex; align-items: center; justify-content: space-between;
  }
  .step-pill {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 6px 14px; border-radius: 999px;
    background: rgba(18, 24, 34, 0.92);
    border: 1px solid rgba(110, 168, 254, 0.36);
    font-size: 13.5px; font-weight: 600; color: #dbe9ff;
  }
  .step-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #46d68c; box-shadow: 0 0 0 4px rgba(70, 214, 140, 0.2);
  }
  .brand-tag {
    font-size: 12px; color: #8c98aa; font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .canvas {
    flex: 1; display: grid; grid-template-columns: 1fr 236px; gap: 24px; align-items: center;
    min-height: 0;
  }
  /* Mac terminal */
  .term {
    height: 422px; border-radius: 16px; overflow: hidden;
    background: #0d1118;
    border: 1px solid rgba(233, 237, 243, 0.11);
    box-shadow: 0 28px 60px rgba(0, 0, 0, 0.55);
    display: flex; flex-direction: column;
  }
  .term-bar {
    height: 34px; padding: 0 14px; display: flex; align-items: center; gap: 10px;
    background: #131924; border-bottom: 1px solid rgba(233, 237, 243, 0.08);
    font-size: 12px; color: #9aa5b4;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .dots { display: inline-flex; gap: 6px; }
  .dots i { width: 10px; height: 10px; border-radius: 50%; display: block; }
  .dots i:nth-child(1) { background: #ff5f57; }
  .dots i:nth-child(2) { background: #febc2e; }
  .dots i:nth-child(3) { background: #28c840; }
  .term-body {
    flex: 1; padding: 16px 18px;
    font: 13px/1.62 ui-monospace, "SF Mono", Menlo, monospace;
    color: #dbe3ee; display: flex; flex-direction: column; gap: 7px;
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
  .agent-box {
    margin-top: 6px; padding: 10px 12px; border-radius: 10px;
    background: rgba(110, 168, 254, 0.07); border: 1px solid rgba(110, 168, 254, 0.24);
  }
  .cursor {
    display: inline-block; width: 7px; height: 14px; background: #6ea8fe;
    vertical-align: -2px; margin-left: 2px;
  }
  /* Phone */
  .phone {
    position: relative; width: 224px; height: 454px; padding: 7px; border-radius: 34px;
    background: linear-gradient(160deg, #2a3240, #141923);
    box-shadow: 0 28px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.1);
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
    border: 2px solid #6ea8fe; background: rgba(110, 168, 254, 0.28);
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
    <div class="brand-tag">${c.badge}</div>
  </div>
  <div class="canvas">
    <div class="term">
      <div class="term-bar">
        <span class="dots"><i></i><i></i><i></i></span>
        <span>MacBook Pro — ~/work/pairfob</span>
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
        <div id="act-agent" class="hidden">
          <p class="dim">~/work/pairfob · feat/auth · claude-code / codex</p>
          <p><span class="acc">›</span> fix session token refresh edge cases</p>
          <p class="dim">• Edited src/app.ts (+14 −5)</p>
          <div class="agent-box" id="wait-box">
            <p class="warn">⏸ Needs you — waiting on diff review</p>
            <p class="dim">$ git diff src/app.ts</p>
          </div>
          <p class="hidden" id="note-received" style="margin-top:6px"><span class="acc">${c.resumed}</span></p>
          <p class="dim hidden" id="agent-working">• Applying review comment &amp; running tests…</p>
          <p class="ok hidden" id="agent-done">${c.passed}</p>
          <p class="hidden" id="agent-prompt"><span class="acc">›</span> <span class="cursor"></span></p>
        </div>
      </div>
    </div>

    <div class="phone">
      <div class="screen">
        <img id="s-connect" src="${connectImg}" />
        <img id="s-list" src="${listImg}" />
        <img id="s-diff" src="${diffImg}" />
        <img id="s-chat" src="${chatImg}" />
        <div class="notif" id="notif">
          <b>${c.notifTitle}</b>
          <span>${c.notifBody}</span>
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
  // Deterministic 9x9 QR-like visual matrix.
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
    for (const k of ["s-connect", "s-list", "s-diff", "s-chat"]) {
      el(k).style.opacity = k === id ? "1" : "0";
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
    const actAgent = el("act-agent");
    const notif = el("notif");
    const card = el("comment-card");
    showTap(0, 0, 0);

    // Act 1: 0..4600ms — pairfob pair + QR scan
    if (ms < 4600) {
      cap.textContent = COPY.caption1;
      actPair.classList.remove("hidden");
      actAgent.classList.add("hidden");
      notif.style.opacity = "0";
      card.style.opacity = "0";

      const chars = Math.min(COPY.cmd.length, Math.floor((ms / 1100) * COPY.cmd.length));
      el("typed-cmd").textContent = COPY.cmd.slice(0, chars);
      el("cmd-cur").style.opacity = ms < 1300 ? "1" : "0";
      el("qr-row").classList.toggle("hidden", ms < 1350);
      el("pair-status").textContent = ms >= 2600 ? COPY.scanHint : "Waiting for phone…";
      el("paired-line").classList.toggle("hidden", ms < 3400);
      showImg(ms < 3500 ? "s-connect" : "s-list");
      return;
    }

    actPair.classList.add("hidden");
    actAgent.classList.remove("hidden");

    // Act 2: 4600..8600ms — Agent waits + Needs you push notification
    if (ms < 8600) {
      cap.textContent = COPY.caption2;
      showImg("s-list");
      card.style.opacity = "0";
      el("note-received").classList.add("hidden");
      el("agent-working").classList.add("hidden");
      el("agent-done").classList.add("hidden");
      el("agent-prompt").classList.add("hidden");

      const np = clamp((ms - 5100) / 350);
      const out = ms > 7600 ? clamp((ms - 7600) / 300) : 0;
      const vis = np * (1 - out);
      notif.style.opacity = String(vis);
      notif.style.transform = "translateY(" + ((1 - vis) * -18).toFixed(1) + "px)";
      if (ms >= 7200 && ms <= 7800) showTap(112, 34, (ms - 7200) / 600);
      return;
    }

    notif.style.opacity = "0";

    // Act 3: 8600..13600ms — Diff review & line comment on phone
    if (ms < 13600) {
      cap.textContent = COPY.caption3;
      showImg("s-diff");
      el("note-received").classList.add("hidden");
      el("agent-working").classList.add("hidden");
      el("agent-done").classList.add("hidden");
      el("agent-prompt").classList.add("hidden");

      if (ms >= 9000 && ms <= 9550) showTap(110, 210, (ms - 9000) / 550);
      const cp = clamp((ms - 9500) / 350);
      card.style.opacity = String(cp);
      card.style.transform = "translateY(" + ((1 - cp) * 18).toFixed(1) + "px)";

      const typed = Math.min(COPY.noteText.length, Math.max(0, Math.floor(((ms - 9950) / 2300) * COPY.noteText.length)));
      el("note-input").textContent = COPY.noteText.slice(0, typed);
      if (ms >= 12700 && ms <= 13300) {
        showTap(168, 416, (ms - 12700) / 600);
        el("send-btn").style.background = "#1d4ed8";
      } else {
        el("send-btn").style.background = "#2563d9";
      }
      return;
    }

    // Act 4: 13600..18000ms — Comment arrives on computer, agent edits & passes tests live
    cap.textContent = COPY.caption4;
    card.style.opacity = "0";
    showImg("s-chat");
    el("note-received").classList.remove("hidden");
    el("agent-working").classList.toggle("hidden", ms < 14400);
    el("agent-done").classList.toggle("hidden", ms < 15600);
    el("agent-prompt").classList.toggle("hidden", ms < 16100);
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
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
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
      "-vf", "palettegen=max_colors=192:stats_mode=diff", palette,
    ]);
    await run([
      "ffmpeg", "-y", "-framerate", String(FPS), "-i", join(framesDir, "f-%04d.png"),
      "-i", palette,
      "-lavfi", "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
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
