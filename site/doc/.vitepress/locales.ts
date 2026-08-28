import type { DefaultTheme } from "vitepress";

export const zhSearch: DefaultTheme.LocalSearchOptions = {
  translations: {
    button: { buttonText: "搜索", buttonAriaLabel: "搜索文档" },
    modal: {
      displayDetails: "显示详细列表",
      resetButtonTitle: "清除查询",
      backButtonTitle: "关闭搜索",
      noResultsText: "没有找到相关内容",
      footer: {
        selectText: "选择",
        selectKeyAriaLabel: "回车",
        navigateText: "切换",
        navigateUpKeyAriaLabel: "上箭头",
        navigateDownKeyAriaLabel: "下箭头",
        closeText: "关闭",
        closeKeyAriaLabel: "Esc",
      },
    },
  },
};

export const enSearch: DefaultTheme.LocalSearchOptions = {
  translations: {
    button: { buttonText: "Search", buttonAriaLabel: "Search docs" },
    modal: {
      displayDetails: "Show detailed list",
      resetButtonTitle: "Reset search",
      backButtonTitle: "Close search",
      noResultsText: "No results",
      footer: {
        selectText: "to select",
        selectKeyAriaLabel: "Enter",
        navigateText: "to navigate",
        navigateUpKeyAriaLabel: "Up arrow",
        navigateDownKeyAriaLabel: "Down arrow",
        closeText: "to close",
        closeKeyAriaLabel: "Escape",
      },
    },
  },
};

// English is the root locale, so its links carry no prefix; Chinese sits at /zh.
const enSidebar: DefaultTheme.Sidebar = [
  {
    text: "Start",
    items: [
      { text: "What it is", link: "/" },
      { text: "Get started", link: "/start" },
      { text: "Install", link: "/install" },
      { text: "FAQ", link: "/faq" },
    ],
  },
  {
    text: "Use",
    items: [
      { text: "Pairing", link: "/pair" },
      { text: "Using the app", link: "/app" },
      { text: "Leave and return", link: "/continue" },
      { text: "Computer commands", link: "/cli" },
      { text: "Multiple devices", link: "/devices" },
      { text: "Notifications", link: "/push" },
    ],
  },
  {
    text: "Design",
    items: [
      { text: "The same screen", link: "/model" },
      { text: "Where capabilities come from", link: "/capabilities" },
      { text: "What the relay cannot see", link: "/security" },
      { text: "How it is wired", link: "/architecture" },
    ],
  },
  {
    text: "More",
    items: [
      { text: "Troubleshooting", link: "/troubleshoot" },
      { text: "Environment", link: "/env" },
      { text: "Glossary", link: "/glossary" },
    ],
  },
];

const zhSidebar: DefaultTheme.Sidebar = [
  {
    text: "开始",
    items: [
      { text: "这是什么", link: "/zh/" },
      { text: "开始使用", link: "/zh/start" },
      { text: "安装", link: "/zh/install" },
      { text: "常见问题", link: "/zh/faq" },
    ],
  },
  {
    text: "使用",
    items: [
      { text: "配对", link: "/zh/pair" },
      { text: "手机上怎么用", link: "/zh/app" },
      { text: "出门和回来", link: "/zh/continue" },
      { text: "电脑上的命令", link: "/zh/cli" },
      { text: "多台设备", link: "/zh/devices" },
      { text: "通知", link: "/zh/push" },
    ],
  },
  {
    text: "设计",
    items: [
      { text: "同一块屏幕", link: "/zh/model" },
      { text: "能力从哪来", link: "/zh/capabilities" },
      { text: "中继看不到什么", link: "/zh/security" },
      { text: "怎么接起来", link: "/zh/architecture" },
    ],
  },
  {
    text: "更多",
    items: [
      { text: "排查", link: "/zh/troubleshoot" },
      { text: "环境变量", link: "/zh/env" },
      { text: "术语", link: "/zh/glossary" },
    ],
  },
];

export const zhTheme: DefaultTheme.Config = {
  logo: "/icon.svg",
  siteTitle: "文档",
  outline: { label: "本页", level: [2, 3] },
  sidebar: zhSidebar,
  nav: [
    { text: "开始", link: "/zh/start" },
    { text: "使用", link: "/zh/app" },
    { text: "设计", link: "/zh/model" },
    { text: "常见问题", link: "/zh/faq" },
  ],
  docFooter: { prev: "上一篇", next: "下一篇" },
  darkModeSwitchLabel: "外观",
  lightModeSwitchTitle: "切到浅色",
  darkModeSwitchTitle: "切到深色",
  sidebarMenuLabel: "目录",
  returnToTopLabel: "回到顶部",
  langMenuLabel: "切换语言",
  skipToContentLabel: "跳到正文",
  footer: {
    message: "密钥只在你的电脑和已配对设备上。pairfob.com 只转发密文。",
    copyright: "Pairfob · Herdr 的手机端",
  },
  notFound: {
    title: "没有这一页",
    quote: "地址可能写错了，或这一页还没写。",
    linkLabel: "回到文档首页",
    linkText: "回到文档首页",
  },
};

export const enTheme: DefaultTheme.Config = {
  logo: "/icon.svg",
  siteTitle: "Docs",
  outline: { label: "On this page", level: [2, 3] },
  sidebar: enSidebar,
  nav: [
    { text: "Start", link: "/start" },
    { text: "Use", link: "/app" },
    { text: "Design", link: "/model" },
    { text: "FAQ", link: "/faq" },
  ],
  docFooter: { prev: "Previous", next: "Next" },
  darkModeSwitchLabel: "Appearance",
  lightModeSwitchTitle: "Switch to light",
  darkModeSwitchTitle: "Switch to dark",
  sidebarMenuLabel: "Menu",
  returnToTopLabel: "Back to top",
  langMenuLabel: "Change language",
  skipToContentLabel: "Skip to content",
  footer: {
    message: "Keys stay on your computer and paired devices. pairfob.com forwards ciphertext only.",
    copyright: "Pairfob · the phone surface for Herdr",
  },
  notFound: {
    title: "Page not found",
    quote: "This URL may be wrong, or the page is not written yet.",
    linkLabel: "Back to the docs home",
    linkText: "Back to the docs home",
  },
};
