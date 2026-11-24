import { installEnvironment } from "../qa/environment";

type Lang = "en" | "zh";

type DemoPreset = {
  id: string;
  label: Record<Lang, string>;
  scene: (wide: boolean, roomy: boolean) => string;
};

const PRESETS: DemoPreset[] = [
  { id: "sessions", label: { en: "Needs you", zh: "需要你" }, scene: (wide) => (wide ? "desktop-guided" : "home-grouped") },
  { id: "chat", label: { en: "Chat", zh: "对话" }, scene: (wide) => (wide ? "desktop-chat" : "chat-complete") },
  { id: "terminal", label: { en: "Terminal", zh: "真终端" }, scene: () => "terminal-frame" },
  { id: "diff", label: { en: "Diff", zh: "看 Diff" }, scene: (_wide, roomy) => (roomy ? "inspector-chat-diff" : "workspace-diff") },
  { id: "board", label: { en: "Board", zh: "画板" }, scene: () => "board-busy" },
  { id: "quota", label: { en: "Quota", zh: "额度" }, scene: () => "quota" },
];

const COPY = {
  en: {
    badge: "Live demo",
    pair: "Pair your computer",
    collapse: "Hide demo bar",
    expand: "Demo controls",
    aria: "Interactive demo controls",
    langToggle: "中文",
    title: "Pairfob Live Demo — try the phone remote in your browser",
  },
  zh: {
    badge: "在线试玩",
    pair: "配对我的电脑",
    collapse: "收起试玩栏",
    expand: "试玩栏",
    aria: "在线试玩快捷切换",
    langToggle: "EN",
    title: "Pairfob 在线试玩 — 免安装体验手机遥控编程 Agent",
  },
} as const;

function readInitialLang(): Lang {
  const query = new URLSearchParams(location.search);
  const explicit = query.get("lang");
  if (explicit === "en" || explicit === "zh") return explicit;
  const cookie = document.cookie.match(/(?:^|;\s*)pairfob_lang=(en|zh)(?:;|$)/);
  if (cookie) return cookie[1] as Lang;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function wideViewport(): boolean {
  return window.innerWidth >= 720;
}

function roomyViewport(): boolean {
  return window.innerWidth >= 900;
}

async function bootDemo(): Promise<void> {
  // Sandbox storage, IndexedDB, fetch and WebSockets before production modules
  // load so visiting /demo never touches real paired credentials on /pair.
  installEnvironment();

  await import("../src/tailwind.css");
  await import("../src/shared/ui/fonts/icon-font.css");
  await import("../src/startup.scss");
  await import("./demo.scss");

  const { createFixtureAPI } = await import("../qa/fixtures");
  const { applyDocumentTheme } = await import("../src/lib/theme");
  applyDocumentTheme();

  const query = new URLSearchParams(location.search);
  let currentLang: Lang = readInitialLang();
  let activePreset = query.get("view") ?? "sessions";
  if (!PRESETS.some((preset) => preset.id === activePreset)) activePreset = "sessions";

  const explicitScene = query.get("scene");
  const initialPreset = PRESETS.find((preset) => preset.id === activePreset) ?? PRESETS[0];
  const initialScene = explicitScene || initialPreset.scene(wideViewport(), roomyViewport());

  document.title = COPY[currentLang].title;
  const api = await createFixtureAPI(currentLang, initialScene);
  await api.ready;

  const bar = document.createElement("aside");
  bar.className = "pf-demo-bar";
  bar.setAttribute("role", "region");

  let collapsed = false;

  function renderBar(): void {
    const strings = COPY[currentLang];
    document.title = strings.title;
    bar.setAttribute("aria-label", strings.aria);
    bar.classList.toggle("is-collapsed", collapsed);
    bar.replaceChildren();

    if (collapsed) {
      const reopen = document.createElement("button");
      reopen.type = "button";
      reopen.className = "pf-demo-pill";
      reopen.setAttribute("aria-expanded", "false");
      const dot = document.createElement("span");
      dot.className = "pf-demo-dot";
      dot.setAttribute("aria-hidden", "true");
      reopen.append(dot, document.createTextNode(strings.expand));
      reopen.addEventListener("click", () => {
        collapsed = false;
        renderBar();
      });
      bar.append(reopen);
      return;
    }

    const head = document.createElement("div");
    head.className = "pf-demo-head";
    const badge = document.createElement("span");
    badge.className = "pf-demo-badge";
    const dot = document.createElement("span");
    dot.className = "pf-demo-dot";
    dot.setAttribute("aria-hidden", "true");
    badge.append(dot, document.createTextNode(strings.badge));
    head.append(badge);

    const tabs = document.createElement("div");
    tabs.className = "pf-demo-tabs";
    tabs.setAttribute("role", "tablist");
    for (const preset of PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pf-demo-tab";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(preset.id === activePreset));
      button.textContent = preset.label[currentLang];
      button.addEventListener("click", () => {
        activePreset = preset.id;
        const target = preset.scene(wideViewport(), roomyViewport());
        renderBar();
        void api.setScene(target);
      });
      tabs.append(button);
    }

    const actions = document.createElement("div");
    actions.className = "pf-demo-actions";

    const langBtn = document.createElement("button");
    langBtn.type = "button";
    langBtn.className = "pf-demo-btn";
    langBtn.textContent = strings.langToggle;
    langBtn.addEventListener("click", () => {
      currentLang = currentLang === "en" ? "zh" : "en";
      renderBar();
      void api.setLanguage(currentLang);
    });

    const cta = document.createElement("a");
    cta.className = "pf-demo-cta";
    cta.href = currentLang === "zh" ? "/zh/#how" : "/#how";
    cta.textContent = strings.pair;

    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "pf-demo-hide";
    hide.setAttribute("aria-label", strings.collapse);
    hide.textContent = "×";
    hide.addEventListener("click", () => {
      collapsed = true;
      renderBar();
    });

    actions.append(langBtn, cta, hide);
    bar.append(head, tabs, actions);
  }

  renderBar();
  document.body.append(bar);
}

void bootDemo();
