import { afterEach, describe, expect, test } from "bun:test";
import "../../test-support/boot-dom";
import { copy, resolveCopy, copyKeys, detectLang, lang, langPref, setLang, setLangPref, t } from "./i18n";
import { enSingular } from "./i18n-en-plurals";
import { en } from "./i18n-en";
import { zh } from "./i18n-zh";

afterEach(() => {
  setLang("zh");
  try {
    localStorage.removeItem("pairfob_lang");
  } catch {
    /* happy-dom may not have storage */
  }
});

describe("i18n catalogs", () => {
  test("english has every chinese key and no extras", () => {
    const zhKeys = copyKeys().sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
    expect(zhKeys.length).toBeGreaterThan(200);
  });

  test("interpolation replaces named slots", () => {
    setLang("en");
    expect(t("boot.connecting", { name: "desk" })).toBe("Connecting back to desk…");
    setLang("zh");
    expect(t("boot.connecting", { name: "desk" })).toBe("正在连回desk…");
  });

  test("update and push catalogs cover the former hardcoded copy", () => {
    expect(t("update.check")).toBe("检查更新");
    expect(t("push.titleBlocked")).toBe("Pairfob · 等待确认");
    setLang("en");
    expect(t("update.check")).toBe("Check for updates");
    expect(t("push.titleDone")).toBe("Pairfob · Turn finished");
    expect(t("quota.window.premium")).toBe("Premium interactions");
    expect(t("ft.webglLost")).toContain("WebGL");
  });
});

describe("one name per action", () => {
  // An action is called the same thing on every row, tile and button that
  // offers it, in the list, the board, the session panel and the files: the verb
  // and the noun, nothing else. The dialog it opens is titled with the row's
  // own words, a confirmation asks about the same noun and its button repeats
  // the row. No row carries an ellipsis: that mark is for something under way.
  const NAMES = { zh: ["改会话名", "改标签页名", "改工作区名", "改文件名"], en: ["Rename session", "Rename tab", "Rename workspace", "Rename file"] } as const;
  for (const language of ["zh", "en"] as const) {
    test(`rename reads the same in the list, the board, the session panel and the files (${language})`, () => {
      setLang(language);
      const [session, tab, workspace, file] = NAMES[language];
      expect([t("menu.renamePane"), t("menu.renameTab"), t("menu.renameWorkspace"), t("fileActions.rename")]).toEqual([session, tab, workspace, file]);
      expect(t("boardMenu.rename")).toBe(session);
      expect(t("boardMenu.renameTab")).toBe(tab);
      // The panel's tile has room for a word: the full name in Chinese, the verb in English, the full name spoken.
      expect(t("pm.tileRename")).toBe(language === "zh" ? session : "Rename");
      expect(t("text.save")).toBe(language === "zh" ? "保存" : "Save");
      expect(t("pm.save")).toBe(t("text.save"));
    });
  }

  const ACTIONS = {
    zh: { closeSession: "关闭会话", closeTab: "关闭标签页", closeWorkspace: "关闭工作区", newTab: "新建标签页", newSession: "新建会话",
      toChat: "返回对话", toTerminal: "返回终端", closeFiles: "关闭文件与更改" },
    en: { closeSession: "Close session", closeTab: "Close tab", closeWorkspace: "Close workspace", newTab: "New tab", newSession: "New session",
      toChat: "Back to chat", toTerminal: "Back to terminal", closeFiles: "Close files and changes" },
  } as const;
  for (const language of ["zh", "en"] as const) {
    test(`close, new tab and back read the same wherever they are offered (${language})`, () => {
      setLang(language);
      const name = ACTIONS[language];
      // The list's row menu and the confirmation's button, the session panel's row and its inline button, the board's row.
      expect([t("op.closePane"), t("pm.closePane"), t("boardMenu.close")]).toEqual([name.closeSession, name.closeSession, name.closeSession]);
      expect([t("op.closeTab"), t("boardMenu.closeTab")]).toEqual([name.closeTab, name.closeTab]);
      expect(t("op.closeWorkspace")).toBe(name.closeWorkspace);
      // The confirmation asks about the same noun, and says what the longer names used to: every session in it ends.
      expect(t("confirm.closePaneTitle")).toBe(language === "zh" ? "关闭这个会话？" : "Close this session?");
      expect(t("confirm.closeTabTitle")).toBe(language === "zh" ? "关闭这个标签页？" : "Close this tab?");
      expect(t("confirm.closeWorkspaceTitle")).toBe(language === "zh" ? "关闭这个工作区？" : "Close this workspace?");
      expect(t("confirm.closeGroupEffect")).toMatch(language === "zh" ? /所有会话/ : /Every session/);
      // The list's row and heading menus, the panel's tile, its page and its spoken name, the board's row and button, the dialog.
      const newTab = ["menu.newTabBeside", "menu.newTabInWorkspace", "menu.newTab", "pm.tileNewTab", "pm.newTabTitle", "boardMenu.newTab", "board.newTab", "form.newTab"] as const;
      expect(newTab.map(key => t(key))).toEqual(newTab.map(() => name.newTab));
      // The create menu's last row and the search's command open the sheet titled the same.
      expect([t("create.title"), t("create.quickMore"), t("rail.createMore"), t("palette.create")]).toEqual(Array(4).fill(name.newSession));
      // One verb for the way back from the files: the header button and the receipt's chip.
      expect([t("workspace.backChat"), t("workspace.backToChat")]).toEqual([name.toChat, name.toChat]);
      expect([t("workspace.back"), t("workspace.backToTerminal")]).toEqual([name.toTerminal, name.toTerminal]);
      // Leaving the files is not closing a workspace: that name is the destructive action's alone.
      expect([t("workspace.closeWorkspace"), t("inspector.close")]).toEqual([name.closeFiles, name.closeFiles]);
    });
  }

  test("no row carries an ellipsis: the mark is for something under way, or a field waiting for text", () => {
    const rows = ["boardMenu.right", "boardMenu.down", "boardMenu.rename", "boardMenu.close", "boardMenu.split", "boardMenu.swapPick",
      "boardMenu.renameTab", "boardMenu.newTab", "boardMenu.closeTab", "palette.create", "palette.computers", "rail.createMore",
      "create.quickMore", "pm.wtOpenBy", "rowbar.select", "fileActions.rename", "fileActions.delete"] as const;
    for (const table of [zh, en] as Array<Record<string, string>>) {
      for (const key of rows) expect(table[key], key).not.toMatch(/(…|\.\.\.)$/);
    }
    const marked = Object.entries(zh).filter(([, text]) => /(…|\.\.\.)$/.test(String(text)));
    expect(marked.filter(([, text]) => !/正在|中…$|等待|请稍候|搜索/.test(String(text)))).toEqual([]);
  });

  test("no older name for it is left in either catalog", () => {
    for (const table of [zh, en]) {
      const stale = Object.entries(table).filter(([key, text]) => !key.startsWith("workspace.")
        && /重命名|修改标签页名|修改工作区名|^Rename…?$|Rename this|关闭这个(会话|工作区)$|整个标签页|再开一页|回到(对话|终端)|^Close (this|the whole) [a-z]+$|another tab/.test(String(text))
        && key !== "pm.tileRename");
      expect(stale).toEqual([]);
    }
  });
});

describe("a confirmation's button answers its title", () => {
  // The title asks with a verb and the confirming button carries the same one,
  // never a generic "OK": what is about to happen reads the same twice.
  const PAIRS = [
    ["confirm.closePaneTitle", "op.closePane"], ["confirm.closeTabTitle", "op.closeTab"], ["confirm.closeWorkspaceTitle", "op.closeWorkspace"],
    ["confirm.closePaneTitle", "pm.closePane"], ["confirm.deleteFileTitle", "fileActions.delete"],
    ["confirm.unpairSelfTitle", "settings.unpair"], ["confirm.unpairDeviceTitle", "settings.unpairOther"],
    ["confirm.forgetTitle", "forget"], ["confirm.updateTitle", "update.now"], ["machines.installTitle", "machines.install"],
  ] as const;
  const VERBS = { zh: /^(现在)?(关闭|删除|解除|忘记|更新|在这台机器上安装|安装)/, en: /^(Close|Delete|Unpair|Forget|Update|Install)/ } as const;
  for (const language of ["zh", "en"] as const) {
    test(`every destructive or confirming action names its verb (${language})`, () => {
      setLang(language);
      for (const [title, action] of PAIRS) {
        const verb = t(action).match(VERBS[language])?.[2] ?? t(action).match(VERBS[language])?.[1];
        expect(verb, action).toBeTruthy();
        expect(t(title), `${title} ↔ ${action}`).toContain(language === "zh" ? verb!.replace("在这台机器上", "") : verb!);
      }
    });
  }
});

describe("language preference", () => {
  test("detectLang prefers chinese then english then english default", () => {
    const nav = globalThis.navigator as { language?: string; languages?: string[] };
    const prevLang = nav.language;
    const prevList = nav.languages;
    Object.defineProperty(nav, "languages", { configurable: true, value: ["fr-FR", "zh-CN"] });
    expect(detectLang()).toBe("zh");
    Object.defineProperty(nav, "languages", { configurable: true, value: ["en-GB"] });
    expect(detectLang()).toBe("en");
    Object.defineProperty(nav, "languages", { configurable: true, value: ["de-DE"] });
    expect(detectLang()).toBe("en");
    Object.defineProperty(nav, "language", { configurable: true, value: prevLang });
    Object.defineProperty(nav, "languages", { configurable: true, value: prevList });
  });

  test("auto clears storage and follows the browser", () => {
    setLangPref("en");
    expect(lang()).toBe("en");
    expect(langPref()).toBe("en");
    expect(t("home.settings")).toBe(en["home.settings"]);
    setLangPref("auto");
    expect(langPref()).toBe("auto");
    expect(["en", "zh"]).toContain(lang());
  });

  test("explicit chinese and english persist", () => {
    setLangPref("zh");
    expect(lang()).toBe("zh");
    expect(t("home.settings")).toBe(zh["home.settings"]);
    setLangPref("en");
    expect(lang()).toBe("en");
    expect(t("home.settings")).toBe("Settings");
  });
});

test("stored nested copy resolves in the current language", () => {
  setLang("zh");
  const detail = copy("ft.loadFail", { error: copy("ft.webglLost") });
  const chinese = resolveCopy(detail);
  setLang("en");
  expect(resolveCopy(detail)).toBe(t("ft.loadFail", { error: t("ft.webglLost") }));
  expect(resolveCopy(detail)).not.toBe(chinese);
});

test("English count copy handles zero, one and many without changing Chinese", () => {
  setLang("en");
  expect(t("diffNotes.count", { count: 0 })).toBe("0 comments");
  expect(t("diffNotes.count", { count: 1 })).toBe("1 comment");
  expect(t("diffNotes.count", { count: 2 })).toBe("2 comments");
  expect(t("trace.runningSteps", { n: 1 })).toBe("Running · 1 step");
  expect(t("trace.nSteps", { n: 2 })).toBe("Run · 2 steps");
  expect(t("tabs.attentionAria", { count: "1" })).toBe("1 session needs you");
  // The notes bar and its receipt hold one note as often as several.
  expect(t("diffNotes.pending", { count: 1 })).toBe("1 comment to send");
  expect(t("diffNotes.pending", { count: 3 })).toBe("3 comments to send");
  expect(t("diffNotes.sentReceipt", { count: 1 })).toBe("Sent 1 comment to the agent");
  expect(t("diffNotes.otherFiles", { count: 1 })).toBe("1 other file also has unsent comments");
  // The session header's back label passes its count as text.
  expect(t("chrome.backWaiting", { n: "1" })).toBe("Back to list, 1 other session waiting on you");
  expect(t("chrome.backWaiting", { n: "2" })).toBe("Back to list, 2 other sessions waiting on you");
  // One session in a tab, one cell, one line, one Worktree: as common as several.
  expect(t("confirm.paneCount", { n: 1 })).toBe("1 session");
  expect(t("confirm.paneCount", { n: 3 })).toBe("3 sessions");
  expect(t("boardMenu.tabPanes", { n: 1 })).toBe("Tab · 1 cell");
  expect(t("boardMenu.tabPanes", { n: 2 })).toBe("Tab · 2 cells");
  expect(t("boardMenu.cols", { n: 1 })).toBe("1 col");
  expect(t("boardMenu.rows", { n: 1 })).toBe("1 row");
  expect(t("boardMenu.rows", { n: 24 })).toBe("24 rows");
  expect(t("pm.copiedLines", { n: "1" })).toBe("Copied 1 line of screen text. Paste into another app.");
  expect(t("pm.copiedLines", { n: "40" })).toBe("Copied 40 lines of screen text. Paste into another app.");
  expect(t("pm.layoutCells", { n: "1" })).toBe("1 cell");
  expect(t("pm.wtCount", { n: "1" })).toBe("1 Worktree");
  expect(t("pm.wtCount", { n: "2" })).toBe("2 Worktrees");
  // Two counts in one string cannot each take a singular: the unit leads and is said once.
  expect(t("boardCanvas.dragRows", { first: "1", second: "11", share: "10" })).toBe("Rows 1 ─ 11 · 10%");
  expect(t("boardCanvas.dragCols", { first: "40", second: "1", share: "90" })).toBe("Cols 40 │ 1 · 90%");
  setLang("zh");
  expect(t("confirm.paneCount", { n: 1 })).toBe("1 个会话");
  expect(t("boardCanvas.dragRows", { first: "1", second: "11", share: "10" })).toBe("1 行 ─ 11 行 · 10%");
  expect(t("chrome.backWaiting", { n: "1" })).toBe("返回列表，另有 1 个会话在等你");
  expect(t("diffNotes.count", { count: 1 })).toBe("1 条批注");
  expect(t("diffNotes.pending", { count: 1 })).toBe("1 条批注待发送");
  expect(t("diffNotes.sentReceipt", { count: 1 })).toBe("1 条批注已发给 Agent");
});

test("singular alternatives preserve every interpolation slot", () => {
  const slots = (text: string) => [...text.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(enSingular)) {
    expect(slots(value!)).toEqual(slots(en[key as keyof typeof en]));
  }
});
