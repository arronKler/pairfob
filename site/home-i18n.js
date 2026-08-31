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
    "nav.start": "怎么用",
    "nav.handoff": "接续",
    "nav.cap": "能力",
    "nav.pair": "配对",
    "nav.faq": "问题",
    "nav.doc": "文档",
    "nav.github": "GitHub 上的源码",
    "nav.feedback": "反馈",
    "lang.aria": "语言",
    "cta.open": "打开 Pairfob",
    "cta.start": "开始使用",
    "cta.computer": "在这台电脑上开始",
    "cta.phone": "在手机打开",
    "cta.phone.hint": "不要在这台电脑打开。",
    "cta.phone.aria": "在手机打开 Pairfob",
    "cta.foot": "在手机打开 Pairfob",
    "hero.eyebrow": "Herdr 的手机端",
    "hero.title": "电脑上跑的 Agent，<br />手机随时接着操作。",
    "hero.clis.aria": "常见的 Coding Agent CLI",
    "hero.lede1": "你在电脑上用",
    // Leading space: the markup closes the Herdr link tight so the English
    // period hugs it, so the Latin/CJK gap has to come from the string.
    "hero.lede2":
      " 跑 Codex、Claude、Grok。Pairfob 让手机接上电脑上正在跑的那些会话，两端谁操作都算数。",
    "hero.figure": "同一群会话同时开在电脑和手机上",
    "hero.same": "手机上是同一份列表",
    "mock.settings": "设置",
    "mock.status": "已连接",
    "mock.create": "新建",
    "pill.need": "等你",
    "pill.work": "工作中",
    "pill.idle": "空闲",
    "start.eyebrow": "怎么用",
    "start.h2": "三步就能用上。",
    "start.lede": "电脑上装一个常驻的 pairfob，手机扫一次码完成配对。之后在手机打开 Pairfob，就是电脑上那一群会话。",
    "start.prereq.b": "先决条件",
    "start.prereq1": "Pairfob 不自带 Agent，它是",
    "start.prereq2": " 的手机端。电脑上要先装好 Herdr 0.7 以上；pairfob 启动时会无感拉起它。装完后",
    "start.prereq3": "会告诉你还缺什么。",
    "start.s1": "在装有 Herdr 的那台电脑上",
    "start.s1note": "第二台电脑也贴这条命令。装好后在已配对的设备上：设置 → 添加另一台电脑。",
    "start.s2": "电脑上开始配对",
    "start.hostnote": "下面两步在电脑终端里做。",
    "start.s3": "用手机打开这个地址，扫电脑上的码",
    "start.s3.phone": "在这台手机打开，扫电脑上的码",
    "start.s3note": "这台电脑留着出示二维码。这个地址给另一台设备打开。",
    "start.s3note.phone": "电脑上留着二维码。点进去扫码，或输入配对码。",
    "start.copy": "复制",
    "handoff.eyebrow": "接续",
    "handoff.h2": "放下鼠标，拿起手机，<br />接着刚才那一步。",
    "handoff.lede": "两端是同一个会话。手机上打的字、点的确认、开的分屏，电脑上立刻就是；反过来也一样。",
    "desk.aria": "电脑上的会话",
    "desk.title": "本机 · Herdr — feat/auth",
    "from.prompt": "再跑一遍 auth 的测试",
    "confirm": "确认",
    "cancel": "取消",
    "ask.worktree": "在 ../feat 创建 worktree？",
    "ask.patch": "把补丁应用到 session.go？",
    "wait.note": "手机和电脑都能点，哪边点的另一边立刻就是",
    "phone.aria": "手机上的同一个会话",
    "dock.field": "点画面或这里输入到终端",
    "dock.send": "发送",
    "beat.desk.b": "在电脑前",
    "beat.desk": "照常用 Herdr。Pairfob 不插手，也不用先开什么。",
    "beat.leave.b": "离开座位",
    "beat.leave": "手机打开就是同一份列表，随时接着操作。",
    "beat.back.b": "坐回来",
    "beat.back": "电脑上什么都不用点，接着就是刚才那一步。",
    "cap.eyebrow": "能力",
    "cap.h2": "回话、确认、换分支，<br />手机上也能做。",
    "cap.lede": "默认进控制：选项可点。真终端给 vim。对话里和 Agent 发消息。电脑当时做不到的，不会画出来。",
    "tile1.h": "一眼看完所有会话",
    "tile1.p": "哪个在等你、哪个还在跑，同一份列表里排好。",
    "tile2.h": "确认框变成两个按钮",
    "tile2.p": "Agent 问 Yes / No 的时候，手机上就是两个按钮，不会替你乱按回车。",
    "tile3.h": "用系统键盘接着说",
    "tile3.p": "听写和自动更正都还在。发出去的字，进的是电脑上那个真实终端。",
    "tile4.h": "控制、终端、对话",
    "tile4.p": "默认进控制。vim 用真终端。对话里直接和 Agent 发消息。",
    "mode.control": "控制",
    "mode.term": "终端",
    "mode.chat": "对话",
    "tile5.h": "切 Git worktree",
    "tile5.p": "列出、新建、打开。路径越出你允许的目录就直接拒绝，不会猜。",
    "tile6.h": "一部设备，多台电脑",
    "tile6.p": "手机、平板或另一台电脑都可以当设备。<br />第二台电脑装好后，设置里添加。",
    "tile6.dev": "这台设备",
    "tile6.host1": "Studio",
    "tile6.host2": "笔记本",
    "cap.note": "能用哪些由电脑当时的 Herdr 说了算。它不支持的操作不会画在界面上，也不会假装成功。",
    "pair.eyebrow": "配对",
    "pair.h2": "配对一次，<br />之后一直在。",
    "pair.lede": "电脑显示二维码，手机一扫就开始。无法扫码时再输入配对码；电脑提示后按一次 Enter。",
    "fob.aria": "扫码优先的配对示例",
    "fob.label": "电脑上的配对窗口",
    "fob.primary": "手机扫码，自动开始",
    "fob.fallback": "无法扫码时，再输入配对码",
    "path.aria": "数据怎么走",
    "path.d1.t": "你的设备",
    "path.d1": "手机或其他已配对设备，密钥只在这一端和电脑上",
    "path.d2.t": "Pairfob relay",
    "path.d2": "只按帧转发密文，不解析、不留屏幕内容",
    "path.d3.t": "你的电脑",
    "path.d3": "pairfob 主动向外连，本机不开任何入站端口",
    "faq.eyebrow": "问题",
    "faq.h2": "常见问题",
    "faq.lede": "账号、合盖、Windows、多台电脑、家里要不要开端口、收费。",
    "faq.q1": "要不要注册 Pairfob 账号？",
    "faq.a1": "不要。没有邮箱登录。电脑跑安装命令，设备扫一次码。",
    "faq.q2": "锁屏或合盖之后还能用吗？",
    "faq.a2": "锁屏可以。合盖只有系统没睡才行。Pairfob 唤不醒已经睡着的电脑。",
    "faq.q3": "能在 Windows 上装 pairfob 吗？",
    "faq.a3": "还不能。Windows 可以打开网页当第二块屏幕，宿主仍是 macOS 或 Linux。",
    "faq.q4": "家里要开端口或开 Tailscale 吗？",
    "faq.a4": "不要。pairfob 只往外连。",
    "faq.q5": "一部设备能管多台电脑吗？",
    "faq.a5": "能。手机、平板、另一台电脑都可以当设备。第二台电脑装好后，设置 → 添加另一台电脑。",
    "faq.q6": "收费吗？",
    "faq.a6": "不收费。",
    "faq.more": "文档里还有",
    "faq.feedback.b": "反馈问题",
    "faq.feedback.p": "功能与体验问题去 GitHub 开 issue。安全漏洞请私下报告。",
    "faq.feedback": "去 GitHub 开 issue",
    "foot.blurb": "不用注册。跑 Herdr 的那台电脑目前要是 macOS 或 Linux。",
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
    "nav.start": "How",
    "nav.handoff": "Continue",
    "nav.cap": "Capabilities",
    "nav.pair": "Pair",
    "nav.faq": "FAQ",
    "nav.doc": "Docs",
    "nav.github": "Source on GitHub",
    "nav.feedback": "Feedback",
    "lang.aria": "Language",
    "cta.open": "Open Pairfob",
    "cta.start": "Get started",
    "cta.computer": "Start on this computer",
    "cta.phone": "On your phone, open",
    "cta.phone.hint": "Don't open it on this computer.",
    "cta.phone.aria": "Open Pairfob on your phone",
    "cta.foot": "On the phone, open Pairfob",
    "hero.eyebrow": "The phone surface for Herdr",
    "hero.title": "Agents that run on your computer,<br />continued from your phone.",
    "hero.clis.aria": "Popular coding agent CLIs",
    "hero.lede1": "You run Codex, Claude, and Grok on the computer with",
    "hero.lede2":
      ". Pairfob attaches the phone to that same herd. Either side counts.",
    "hero.figure": "The same sessions open on computer and phone",
    "hero.same": "Same list on the phone",
    "mock.settings": "Settings",
    "mock.status": "Connected",
    "mock.create": "New",
    "pill.need": "Needs you",
    "pill.work": "Working",
    "pill.idle": "Idle",
    "start.eyebrow": "How",
    "start.h2": "Three steps and you are in.",
    "start.lede": "Install a resident pairfob on the computer, scan once to pair. After that, Pairfob on the phone is the herd on that computer.",
    "start.prereq.b": "Prerequisite",
    "start.prereq1": "Pairfob does not ship an agent. It is the phone surface for",
    "start.prereq2": ". Install Herdr 0.7 or newer; pairfob quietly starts it on launch. After installation,",
    "start.prereq3": "tells you what is still missing.",
    "start.s1": "On the computer with Herdr installed",
    "start.s1note": "Same command on another computer. Then on a paired device: Settings → Add another computer.",
    "start.s2": "Start pairing on the computer",
    "start.hostnote": "The next two steps run in a terminal on the computer.",
    "start.s3": "On the phone, open this URL and scan",
    "start.s3.phone": "On this phone, open Pairfob and scan",
    "start.s3note": "Leave this computer on the QR. Open the URL on the other device.",
    "start.s3note.phone": "Leave the QR on the computer. Tap to scan, or type the pairing code.",
    "start.copy": "Copy",
    "handoff.eyebrow": "Continue",
    "handoff.h2": "Put the mouse down, pick the phone up,<br />same step.",
    "handoff.lede": "Both sides are one session. Text, confirms, and splits on the phone land on the computer immediately — and the other way around.",
    "desk.aria": "Session on the computer",
    "desk.title": "This machine · Herdr — feat/auth",
    "from.prompt": "run the auth tests again",
    "confirm": "Confirm",
    "cancel": "Cancel",
    "ask.worktree": "Create worktree at ../feat?",
    "ask.patch": "Apply patch to session.go?",
    "wait.note": "Either side can tap; the other side is already there",
    "phone.aria": "The same session on the phone",
    "dock.field": "Tap the screen or type here",
    "dock.send": "Send",
    "beat.desk.b": "At the desk",
    "beat.desk": "use Herdr as usual. Pairfob stays out of the way.",
    "beat.leave.b": "Leaving",
    "beat.leave": "open the phone and it is the same list. Continue whenever.",
    "beat.back.b": "Sitting down",
    "beat.back": "tap nothing on the computer. You are already on that step.",
    "cap.eyebrow": "Capabilities",
    "cap.h2": "Reply, confirm, switch branch —<br />the phone does that too.",
    "cap.lede": "Control is tappable. Terminal is the real PTY. Chat is messaging the agent. What the live Herdr cannot do is not drawn.",
    "tile1.h": "Every session in one list",
    "tile1.p": "Who needs you, who is still running — one ordered list.",
    "tile2.h": "Dialogs become two buttons",
    "tile2.p": "When the agent asks Yes / No, the phone shows two buttons. It will not fire Enter for you.",
    "tile3.h": "Keep talking with the system keyboard",
    "tile3.p": "Dictation and autocorrect stay. What you send lands in the real terminal on the computer.",
    "tile4.h": "Control, terminal, chat",
    "tile4.p": "Control by default. Real PTY for vim. Chat is messaging the agent.",
    "mode.control": "Control",
    "mode.term": "Terminal",
    "mode.chat": "Chat",
    "tile5.h": "Switch Git worktrees",
    "tile5.p": "List, create, open. A path outside the allowed roots is refused. No guessing.",
    "tile6.h": "One device, several computers",
    "tile6.p": "A phone, tablet, or another computer can be the device.<br />After the second host is installed, add it in Settings.",
    "tile6.dev": "This device",
    "tile6.host1": "Studio",
    "tile6.host2": "Laptop",
    "cap.note": "What is available is whatever the live Herdr on the computer declared. Unsupported operations are not drawn, and they are not faked as success.",
    "pair.eyebrow": "Pair",
    "pair.h2": "Pair once.<br />It stays.",
    "pair.lede": "The computer shows a QR code; scan on the phone to start. Type the code if you cannot scan. Press Enter once when the computer asks.",
    "fob.aria": "Scan-first pairing",
    "fob.label": "Pairing on the computer",
    "fob.primary": "Scan on the phone; it starts on its own",
    "fob.fallback": "Cannot scan? Type the pairing code",
    "path.aria": "How data moves",
    "path.d1.t": "Your device",
    "path.d1": "Phone or another paired device. Keys stay here and on the computer",
    "path.d2.t": "Pairfob relay",
    "path.d2": "Forwards ciphertext frames. Does not parse or keep screen contents",
    "path.d3.t": "Your computer",
    "path.d3": "pairfob dials out. No inbound ports on the machine",
    "faq.eyebrow": "FAQ",
    "faq.h2": "A few things people get stuck on.",
    "faq.lede": "Accounts, a closed lid, Windows, several computers, inbound ports, and whether it costs money.",
    "faq.q1": "Do I need a Pairfob account?",
    "faq.a1": "No. There is no email login. The computer runs the install command; the device scans once.",
    "faq.q2": "Does locking the screen or closing the lid still work?",
    "faq.a2": "A locked screen is fine. A closed lid only works if the machine does not sleep. Pairfob cannot wake a sleeping computer.",
    "faq.q3": "Can I install pairfob on Windows?",
    "faq.a3": "Not yet. A Windows machine can open the page as another screen. The host still has to be macOS or Linux.",
    "faq.q4": "Do I need Tailscale or an inbound port?",
    "faq.a4": "No. pairfob only dials out.",
    "faq.q5": "Can one device manage several computers?",
    "faq.a5": "Yes. A phone, tablet, or another computer can be the device. After the second host is installed: Settings → Add another computer.",
    "faq.q6": "Does it cost money?",
    "faq.a6": "No.",
    "faq.more": "More in the docs",
    "faq.feedback.b": "Report an issue",
    "faq.feedback.p": "Bugs and product feedback go to GitHub Issues. Security reports stay private.",
    "faq.feedback": "Open a GitHub issue",
    "foot.blurb": "No account. The computer that runs Herdr has to be macOS or Linux for now.",
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
      const key = el.getAttribute("data-i18n");
      const value = text(lang, key);
      if (!value) return;
      if (el.hasAttribute("data-i18n-html")) el.innerHTML = value;
      else el.textContent = value;
    });
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const value = text(lang, el.getAttribute("data-i18n-aria"));
      if (value) el.setAttribute("aria-label", value);
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
        data.softwareRequirements = lang === "en" ? "Herdr 0.7 or newer" : "Herdr 0.7 或更高版本";
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
