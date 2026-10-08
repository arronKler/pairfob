(function () {
  const ORIGIN = "https://pairfob.com";

  const zh = {
    title: "Pairfob — 手机接着操作电脑上的 AI Agent 会话",
    description:
      "在手机上接着操作电脑里正在跑的 AI 编码 Agent。Pairfob 是 Herdr 的手机端，Codex、Claude、Grok 的会话两端同步，端到端加密，不用 VPN、不开公网端口。",
    "og.image.alt": "Pairfob：电脑和手机上是同一份 Agent 会话列表",
    skip: "跳到正文",
    "brand.aria": "Pairfob 首页",
    "nav.aria": "本页",
    "nav.how": "怎么用",
    "nav.what": "能做什么",
    "nav.safe": "安全吗",
    "nav.faq": "常见问题",
    "nav.doc": "文档",
    "nav.github": "GitHub 上的源码",
    "nav.feedback": "反馈",
    "lang.aria": "语言",
    "cta.start": "开始使用",
    "cta.open": "打开 Pairfob",
    "start.copy": "复制",

    "hero.chip": "Herdr 的手机端",
    "hero.chip2": "开源 · 免费",
    "hero.title": "电脑上跑的 Agent，<br />手机随时接着操作。",
    "hero.tick1": "浏览器打开就能用，不装 App",
    "hero.tick2": "不用注册",
    "hero.tick3": "端到端加密",
    "hero.sub":
      "Codex、Claude 在电脑上跑着，你<b>离开座位也不用停</b>：在手机上看进度、回它一句、替它按下确认。手机和电脑是<b>同一个终端</b>，不是远程桌面。",
    "hero.cta.how": "三步开始用",
    "hero.cta.see": "看看手机上长什么样",
    "hero.cta.install": "先在电脑上安装",
    "hero.figure": "同一个会话同时开在电脑终端和手机上",
    "demo.prev": "修一下 session 过期的测试",
    "demo.prompt": "再跑一遍 auth 的测试",
    "demo.ph": "组字 · 写完点发送",
    "demo.send": "发送",
    "demo.stop": "停止",
    "demo.done": "本轮结束",
    "demo.work": "工作中",
    "demo.wait": "等你",
    "demo.sync": "同一个会话，两边实时同步",
    beat1: "手机上写一句",
    beat2: "点发送，电脑终端里就有了",
    beat3: "Agent 停下来问你",
    beat4: "手机点 Enter，两边一起继续",
    "anim.pause": "暂停动画",
    "anim.play": "播放动画",
    "logos.lead": "<b>Herdr</b> 是电脑上跑 coding agent 的本机程序，里面跑的都能接：",

    "how.ask": "怎么用？",
    "how.h2": "电脑上装一次，手机扫一次码。",
    "how.p": "前两步在装有 Herdr 的电脑终端里做，第三步在手机上。之后就不用再配了。",
    "req.aria": "使用条件",
    "req1.b": "电脑",
    req1: "macOS 或 Linux，装好 Herdr 0.8+",
    "req2.b": "手机 / 平板",
    req2: "浏览器打开即可，iOS 建议用 Safari 添加到主屏幕",
    "req3.b": "网络",
    req3: "两边能上网就行，不用开端口",
    "where.pc": "在电脑上",
    "where.phone": "在手机上",
    "s1.term1": "# 在电脑终端里",
    "s1.term2": "校验下载 · 注册这台电脑 · 装成用户服务",
    "s1.term3": "之后开机自动运行，并拉起 Herdr",
    "s1.term4": "缺什么，它会告诉你",
    "s1.h": "安装 pairfob",
    "s1.p":
      '需要先装好 <a href="https://herdr.dev" target="_blank" rel="noreferrer">Herdr</a> 0.8+（电脑上跑 coding agent 的程序，Pairfob 不替代它）。支持 macOS 和 Linux。',
    "s2.h": "运行 <code>pairfob pair</code>",
    "s2.p": "终端里出现二维码。先别关，留着给手机扫。",
    "s3.h": "打开 pairfob.com/pair 扫码",
    "s3.p": "扫完，电脑终端出现 <code>Press Enter to pair</code>，回电脑按一下 Enter 就配好了。",
    "s3.hint": "在手机上打开，不要在这台电脑打开。",
    "s3.open": "打开 Pairfob 扫码",
    "after1.b": "之后每一次",
    after1: "手机打开 <code>pairfob.com/pair</code> 或主屏幕图标，就是电脑上那几个会话。",
    "after2.b": "第二台电脑",
    after2: "同样跑第 1 步，然后在手机上「设置 → 切换电脑 → 添加电脑」。",

    "what.ask": "能帮你做什么？",
    "what.h2": "人不在电脑前，<br />Agent 也不用干等你。",
    "what.p": "点任意一项看对应的真实界面。",
    "tour.aria": "手机上能做的事",
    "tour.pause": "暂停轮播",
    "tour.play": "自动轮播",
    "t1.h": "一眼看到谁在等你",
    "t1.tag": "需要你 2",
    "t1.p": "所有会话按工作区分组。停下来等你的，会亮在顶部「需要你」一栏，点一下直达。",
    "t1.alt": "会话列表按工作区分组，顶部是「需要你」",
    "t2.h": "回它一句话",
    "t2.p": "用系统键盘写，听写、自动更正、多行都行。写完点发送，文字进的是电脑上那个真实终端。",
    "t2.alt": "会话页，输入框里写了两行消息",
    "t3.h": "按键一个不少",
    "t3.p": "Esc、方向键、Tab、Ctrl、Shift、Ctrl+C……在 TUI 里选选项、打断任务都能按。",
    "t3.alt": "会话页，展开了完整按键面板",
    "t4.h": "看它改了什么",
    "t4.p": "看它改了哪些文件，一个个翻 diff。点一行写批注，直接发给 Agent。",
    "t4.alt": "src/app.ts 未提交改动的 diff",
    "t5.h": "像聊天一样读结果",
    "t5.p": "对话模式把执行过程和回复排成消息，在手机上读长回复更轻松。",
    "t5.alt": "对话模式，显示执行过程和回复",
    "t6.h": "订阅额度还剩多少",
    "t6.p": "Codex、Claude、Copilot、Cursor、Grok……这台电脑上各家额度一眼看到。",
    "t6.alt": "设置页，每家订阅各有一个额度环",
    "wide.h": '<span class="nw">平板和另一台电脑，</span><span class="nw">打开也一样。</span>',
    "wide.p": "平板横过来就是左右两栏：左边会话列表，右边就是那个终端。",
    "wide.alt": "平板横屏上的 Pairfob：会话列表在左，终端在右",
    "x1.b": "一部设备管多台电脑",
    x1: "公司的、家里的，在设置里切换。",
    "x2.b": "等你时推送提醒",
    x2: "可选开启，点通知直达那个会话。",
    "x3.b": "在手机上新建会话",
    x3: "选工作区、选 Agent，就开跑。",
    "x4.b": "切 Git worktree",
    x4: "列出、新建、打开，越界路径直接拒绝。",
    "what.fine": "能用哪些，由电脑上当时的 Herdr 决定；它不支持的操作不会出现在界面上，也不会假装成功。",

    "vs.ask": "和别的方式有什么不同？",
    "vs.h2": "不是远程桌面，<br />也不是把 Agent 搬到云上。",
    "vs.not": "不是",
    "vs1.not": "远程桌面 / VNC / 投屏",
    "vs1.is": "只接会话，不搬整个桌面",
    "vs2.not": "浏览器里再开一个终端",
    "vs2.is": "打开电脑上已经在跑的会话",
    "vs3.not": "把 Agent 搬到云上",
    "vs3.is": "Agent 仍在你电脑上跑",
    "vs4.not": "精简版手机专用 Agent",
    "vs4.is": "电脑当时能做的，手机上也能做",
    "vs5.not": "账号登录",
    "vs5.is": "配对就是授权，凭证只在这台浏览器里",
    "vs6.not": "VPN / Tailscale",
    "vs6.is": "电脑主动连出去，家里不用开端口",

    "safe.ask": "安全吗？",
    "safe.h2": "能直连就直连，<br />会话连中转都不经过。",
    "safe.p":
      "默认优先让手机和电脑直接连上（P2P），会话数据不经过 pairfob.com。只有直连不通时才走中转，而中转也只转发密文，看不到画面和你打的字。",
    "route.p2p": "默认优先 · P2P 直连",
    "route.phone": "你的手机",
    "route.pc": "你的电脑",
    "route.key": "持有密钥",
    "route.wire": "端到端加密 · 不经过中转",
    "route.relay": "直连不通时 · 走中转",
    "route.phone.s": "手机",
    "route.pc.s": "电脑",
    "route.cipher": "密文",
    "route.relay.b": "pairfob.com 中转",
    "route.relay.p": "只转发密文：知道该送到哪台电脑，看不到内容，也不保存。",
    "safe.fine":
      "中转还负责帮两边找到对方，协商直连用的信息同样是密文。为了找到直连路径，浏览器会向 Cloudflare 的公网地址查询服务问一次，它能看到这台设备的公网地址。",
    "g1.b": "两条路都加密",
    g1: "直连还是中转，内容都是端到端加密。",
    "g2.b": "不开端口",
    g2: "不用 VPN、不用 Tailscale、不用改路由器。",
    "g3.b": "必须电脑按 Enter",
    g3: "配对要在电脑终端确认，别人拍到二维码也配不上。",
    "g4.b": "不用账号 · 开源",
    g4: "没有邮箱登录；Apache-2.0，代码在 GitHub。",

    "faq.ask": "还有疑问？",
    "faq.h2": "常见问题",
    "faq.feedback":
      '没找到答案？看<a href="/doc/zh/faq" data-locale-href="faq">文档</a>，或者<a href="https://github.com/arronKler/pairfob/issues/new" target="_blank" rel="noreferrer">去 GitHub 开 issue</a>。安全漏洞请私下报告。',
    "faq.q0": "要不要在手机上装 App？",
    "faq.a0": "不用。在手机浏览器打开 pairfob.com/pair 就行，添加到主屏幕后用起来像一个 App。",
    "faq.q2": "锁屏或合盖之后还能用吗？",
    "faq.a2": "锁屏可以。合盖只有系统没睡才行。Pairfob 唤不醒已经睡着的电脑。",
    "faq.q3": "能在 Windows 上装 pairfob 吗？",
    "faq.a3": "还不能。Windows 可以打开网页当第二块屏幕，宿主仍是 macOS 或 Linux。",
    "faq.q4": "家里要开端口或开 Tailscale 吗？",
    "faq.a4": "不要。pairfob 只往外连。",
    "faq.q5": "一部设备能管多台电脑吗？",
    "faq.a5": "能。手机、平板、另一台电脑都可以当设备。第二台电脑装好后，设置 → 切换电脑 → 添加电脑。",
    "faq.q6": "收费吗？",
    "faq.a6": "不收费。",

    "close.h2": "离开座位之前，<br />先把它装上。",
    "close.p": "在装有 Herdr 的电脑终端里运行：",
    "close.then": "然后运行 <b>pairfob pair</b>，用手机打开 <b>pairfob.com/pair</b> 扫码。",
    "close.phone": "已经在电脑上装好了？",
    "foot.blurb": "Pairfob · Herdr 的手机端。跑 Herdr 的那台电脑目前要是 macOS 或 Linux。",
    "foot.aria": "页脚",
  };

  const en = {
    title: "Pairfob — continue the AI agent session on your computer from your phone",
    description:
      "Continue the coding agents already running on your computer from your phone. Pairfob is the phone surface for Herdr: Codex, Claude, and Grok stay one session on both sides, end-to-end encrypted, no VPN and no inbound ports.",
    "og.image.alt": "Pairfob: the same agent list on computer and phone",
    skip: "Skip to content",
    "brand.aria": "Pairfob home",
    "nav.aria": "On this page",
    "nav.how": "How it works",
    "nav.what": "What it does",
    "nav.safe": "Security",
    "nav.faq": "FAQ",
    "nav.doc": "Docs",
    "nav.github": "Source on GitHub",
    "nav.feedback": "Feedback",
    "lang.aria": "Language",
    "cta.start": "Get started",
    "cta.open": "Open Pairfob",
    "start.copy": "Copy",

    "hero.chip": "The phone surface for Herdr",
    "hero.chip2": "Open source · Free",
    "hero.title": "Agents that run on your computer,<br />continued from your phone.",
    "hero.tick1": "Runs in the browser, no app to install",
    "hero.tick2": "No account",
    "hero.tick3": "End-to-end encrypted",
    "hero.sub":
      "Codex and Claude keep running on your computer, and <b>leaving your desk doesn't stop the work</b>: check progress, reply, and confirm from your phone. Phone and computer share <b>the same terminal</b>. It is not a remote desktop.",
    "hero.cta.how": "Get started in 3 steps",
    "hero.cta.see": "See it on the phone",
    "hero.cta.install": "Install on your computer first",
    "hero.figure": "The same session open in the computer terminal and on the phone",
    "demo.prev": "fix the session expiry test",
    "demo.prompt": "run the auth tests again",
    "demo.ph": "Compose · tap Send when done",
    "demo.send": "Send",
    "demo.stop": "Stop",
    "demo.done": "Turn finished",
    "demo.work": "Working",
    "demo.wait": "Needs you",
    "demo.sync": "One session, live on both screens",
    beat1: "Write on the phone",
    beat2: "Tap Send and it's in the computer's terminal",
    beat3: "The agent stops to ask",
    beat4: "Tap Enter on the phone and both sides carry on",
    "anim.pause": "Pause animation",
    "anim.play": "Play animation",
    "logos.lead": "<b>Herdr</b> runs coding agents on your computer. Pairfob picks up any of them:",

    "how.ask": "How does it work?",
    "how.h2": "Install once on the computer, scan once with the phone.",
    "how.p":
      "The first two steps run in a terminal on the computer with Herdr; the third is on your phone. After that, you're set.",
    "req.aria": "Requirements",
    "req1.b": "Computer",
    req1: "macOS or Linux with Herdr 0.8+",
    "req2.b": "Phone / tablet",
    req2: "Just a browser; on iOS, add it to the Home Screen from Safari",
    "req3.b": "Network",
    req3: "Both sides online, no ports to open",
    "where.pc": "On the computer",
    "where.phone": "On the phone",
    "s1.term1": "# in a terminal on the computer",
    "s1.term2": "verifies the download · enrolls this computer · installs a user service",
    "s1.term3": "then starts at login and launches Herdr",
    "s1.term4": "tells you what is still missing",
    "s1.h": "Install pairfob",
    "s1.p":
      'Needs <a href="https://herdr.dev" target="_blank" rel="noreferrer">Herdr</a> 0.8+, which runs your coding agents; Pairfob doesn\'t replace it. macOS and Linux.',
    "s2.h": "Run <code>pairfob pair</code>",
    "s2.p": "A QR code appears in the terminal. Leave it there for the phone.",
    "s3.h": "Open pairfob.com/pair and scan",
    "s3.p":
      "After the scan, the terminal shows <code>Press Enter to pair</code>. Press Enter on the computer and you're paired.",
    "s3.hint": "Open it on your phone. Don't open it on this computer.",
    "s3.open": "Open Pairfob and scan",
    "after1.b": "Every time after",
    after1: "Open <code>pairfob.com/pair</code> or the Home Screen icon and you're in your computer's sessions.",
    "after2.b": "A second computer",
    after2: "Run step 1 there too, then on your phone: Settings → Switch computer → Add a computer.",

    "what.ask": "What does it do for you?",
    "what.h2": "You're away from the desk.<br />Your agents don't have to wait.",
    "what.p": "Tap any item to see the real screen.",
    "tour.aria": "What you can do on the phone",
    "tour.pause": "Pause",
    "tour.play": "Autoplay",
    "t1.h": "See who needs you",
    "t1.tag": "Needs you 2",
    "t1.p":
      "Sessions are grouped by workspace. Anything waiting on you lights up in the Needs you strip at the top; one tap takes you there.",
    "t1.alt": "Session list grouped by workspace, with Needs you at the top",
    "t2.h": "Reply in a sentence",
    "t2.p":
      "Write with the system keyboard: dictation, autocorrect, several lines. Tap Send and it goes into the real terminal on your computer.",
    "t2.alt": "Session screen with a two-line message in the compose box",
    "t3.h": "Every key you need",
    "t3.p": "Esc, arrows, Tab, Ctrl, Shift, Ctrl+C… pick an option in a TUI or interrupt a task.",
    "t3.alt": "Session screen with the full key pad open",
    "t4.h": "See what it changed",
    "t4.p": "Go through the changed files one diff at a time. Tap a line, write a note, and send it to the agent.",
    "t4.alt": "Diff of an uncommitted change in src/app.ts",
    "t5.h": "Read results like a chat",
    "t5.p": "Chat mode lays out the steps and the reply as messages, easier to read on a phone.",
    "t5.alt": "Chat mode with the run steps and the reply",
    "t6.h": "How much quota is left",
    "t6.p": "Codex, Claude, Copilot, Cursor, Grok… see what's left on each plan used on this computer.",
    "t6.alt": "Settings with a quota ring for each plan",
    "wide.h": '<span class="nw">On a tablet or another computer,</span> <span class="nw">it works the same.</span>',
    "wide.p": "Turn a tablet sideways for two columns: sessions on the left, the terminal on the right.",
    "wide.alt": "Pairfob on a tablet in landscape: the session list beside the terminal",
    "x1.b": "One device, several computers",
    x1: "Work and home machines; switch in Settings.",
    "x2.b": "A push when it needs you",
    x2: "Optional. Tap the notification to land in that session.",
    "x3.b": "Start sessions from the phone",
    x3: "Pick a workspace and an agent, and go.",
    "x4.b": "Switch Git worktrees",
    x4: "List, create, open. Paths outside the allowed roots are refused.",
    "what.fine":
      "What's available is whatever the live Herdr on your computer supports. Unsupported actions aren't shown, and never faked as success.",

    "vs.ask": "How is it different?",
    "vs.h2": "Not a remote desktop,<br />and not agents in the cloud.",
    "vs.not": "Not",
    "vs1.not": "Remote desktop / VNC / screen share",
    "vs1.is": "Attaches to sessions, not the whole desktop",
    "vs2.not": "Another terminal in the browser",
    "vs2.is": "Opens the session already running on the computer",
    "vs3.not": "Agents moved into the cloud",
    "vs3.is": "Agents still run on your computer",
    "vs4.not": "A cut-down mobile agent",
    "vs4.is": "What the computer can do is what the phone can do",
    "vs5.not": "An account login",
    "vs5.is": "Pairing is authorization; the credential stays in this browser",
    "vs6.not": "A VPN / Tailscale",
    "vs6.is": "The computer dials out; you do not open ports at home",

    "safe.ask": "Is it secure?",
    "safe.h2": "Direct whenever possible:<br />sessions skip the relay.",
    "safe.p":
      "By default your phone and computer connect directly (P2P), so session data never passes through pairfob.com. Only when a direct path fails does it go through the relay, and the relay only forwards ciphertext; it can't see the screen or what you type.",
    "route.p2p": "Preferred · P2P direct",
    "route.phone": "Your phone",
    "route.pc": "Your computer",
    "route.key": "Holds the keys",
    "route.wire": "End-to-end encrypted · skips the relay",
    "route.relay": "If direct fails · via the relay",
    "route.phone.s": "Phone",
    "route.pc.s": "Computer",
    "route.cipher": "ciphertext",
    "route.relay.b": "pairfob.com relay",
    "route.relay.p": "Forwards ciphertext only: it knows which computer to deliver to, but can't read or keep the content.",
    "safe.fine":
      "The relay also helps the two sides find each other; the messages that set up the direct link are encrypted too. To find a direct path, the browser asks Cloudflare's public-address lookup service once, and that service sees this device's public IP address.",
    "g1.b": "Encrypted either way",
    g1: "Direct or relayed, the content is end-to-end encrypted.",
    "g2.b": "No open ports",
    g2: "No VPN, no Tailscale, no router changes.",
    "g3.b": "Enter on the computer",
    g3: "Pairing is approved in the computer's terminal, so a photo of your QR code isn't enough.",
    "g4.b": "No account · open source",
    g4: "No email login. Apache-2.0, with the code on GitHub.",

    "faq.ask": "Still have questions?",
    "faq.h2": "FAQ",
    "faq.feedback":
      'Didn\'t find it? Read the <a href="/doc/faq" data-locale-href="faq">docs</a> or <a href="https://github.com/arronKler/pairfob/issues/new" target="_blank" rel="noreferrer">open a GitHub issue</a>. Report security issues privately.',
    "faq.q0": "Do I need to install an app on my phone?",
    "faq.a0": "No. Open pairfob.com/pair in the phone's browser. Add it to the Home Screen and it works like an app.",
    "faq.q2": "Does locking the screen or closing the lid still work?",
    "faq.a2": "A locked screen is fine. A closed lid only works if the machine does not sleep. Pairfob cannot wake a sleeping computer.",
    "faq.q3": "Can I install pairfob on Windows?",
    "faq.a3": "Not yet. A Windows machine can open the page as another screen. The host still has to be macOS or Linux.",
    "faq.q4": "Do I need Tailscale or an inbound port?",
    "faq.a4": "No. pairfob only dials out.",
    "faq.q5": "Can one device manage several computers?",
    "faq.a5":
      "Yes. A phone, tablet, or another computer can be the device. After the second host is installed: Settings → Switch computer → Add a computer.",
    "faq.q6": "Does it cost money?",
    "faq.a6": "No.",

    "close.h2": "Before you leave your desk,<br />set it up.",
    "close.p": "Run this in a terminal on the computer with Herdr:",
    "close.then": "Then run <b>pairfob pair</b> and scan with your phone at <b>pairfob.com/pair</b>.",
    "close.phone": "Already set up on your computer?",
    "foot.blurb": "Pairfob · the phone surface for Herdr. The computer that runs Herdr has to be macOS or Linux for now.",
    "foot.aria": "Footer",
  };

  const COPY = { zh, en };

  function text(lang, key) {
    const table = COPY[lang] || COPY.zh;
    return table[key] ?? COPY.zh[key] ?? "";
  }

  function apply(lang) {
    const root = document;
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      const value = text(lang, el.getAttribute("data-i18n"));
      if (!value) return;
      if (el.hasAttribute("data-i18n-html")) el.innerHTML = value;
      else el.textContent = value;
    });
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const value = text(lang, el.getAttribute("data-i18n-aria"));
      if (value) el.setAttribute("aria-label", value);
    });
    root.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      const value = text(lang, el.getAttribute("data-i18n-alt"));
      if (value) el.setAttribute("alt", value);
    });
    // Product stills are captured per locale (scripts/site-shots.ts); the static
    // src is English and data-src-zh holds the Chinese capture.
    root.querySelectorAll("img[data-src-zh]").forEach((img) => {
      if (!img.dataset.srcEn) img.dataset.srcEn = img.getAttribute("src");
      const next = lang === "zh" ? img.dataset.srcZh : img.dataset.srcEn;
      if (img.getAttribute("src") !== next) img.setAttribute("src", next);
    });
    document.title = text(lang, "title");
    const desc = text(lang, "description");
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute("content", desc);
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute("content", text(lang, "title"));
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute("content", desc);
    const ogLocale = document.querySelector('meta[property="og:locale"]');
    if (ogLocale) ogLocale.setAttribute("content", lang === "en" ? "en_US" : "zh_CN");
    const altLocale = document.querySelector('meta[property="og:locale:alternate"]');
    if (altLocale) altLocale.setAttribute("content", lang === "en" ? "zh_CN" : "en_US");
    const url = ORIGIN + (lang === "en" ? "/" : "/zh/");
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute("content", url);
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute("href", url);
    // Only matters for a JS-rendering crawler; unfurlers read the static head.
    const card = ORIGIN + (lang === "en" ? "/og-en.png" : "/og.png");
    document
      .querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')
      .forEach((el) => el.setAttribute("content", card));
    const cardAlt = document.querySelector('meta[property="og:image:alt"]');
    if (cardAlt) cardAlt.setAttribute("content", text(lang, "og.image.alt"));
    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    if (twitterTitle) twitterTitle.setAttribute("content", text(lang, "title"));
    const twitterDesc = document.querySelector('meta[name="twitter:description"]');
    if (twitterDesc) twitterDesc.setAttribute("content", desc);

    const docHref = lang === "en" ? "/doc/" : "/doc/zh/";
    document.querySelectorAll("[data-locale-href=doc]").forEach((el) => el.setAttribute("href", docHref));
    const faqHref = lang === "en" ? "/doc/faq" : "/doc/zh/faq";
    document.querySelectorAll("[data-locale-href=faq]").forEach((el) => el.setAttribute("href", faqHref));

    document.querySelectorAll(".lang-btn").forEach((btn) => {
      const on = btn.getAttribute("data-lang") === lang;
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    const ld = document.querySelector('script[type="application/ld+json"]');
    if (ld) {
      try {
        const data = JSON.parse(ld.textContent);
        data.url = url;
        data.description = desc;
        data.softwareRequirements = lang === "en" ? "Herdr 0.8 or newer" : "Herdr 0.8 或更高版本";
        ld.textContent = JSON.stringify(data);
      } catch {
        /* leave original */
      }
    }
  }

  function syncUrl(lang) {
    const want = PairfobLang.marketingPath(lang);
    const path = location.pathname === "/zh" || location.pathname.startsWith("/zh/") ? "/zh/" : "/";
    if (!PairfobLang.samePath(want, path)) {
      history.replaceState(null, "", want + location.search + location.hash);
    }
  }

  function choose(lang) {
    const value = PairfobLang.set(lang);
    apply(value);
    syncUrl(value);
    PairfobLang.notify(value);
  }

  function bootMarketing() {
    if (!window.PairfobLang) return;
    const lang = PairfobLang.prefer(location.pathname);
    if (!PairfobLang.readSaved()) PairfobLang.set(lang);
    apply(lang);
    syncUrl(lang);
    PairfobLang.notify(lang);
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.addEventListener("click", () => choose(btn.getAttribute("data-lang")));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootMarketing);
  } else {
    bootMarketing();
  }
})();
