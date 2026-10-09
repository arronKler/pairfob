import { describe, expect, test } from "bun:test";

async function markdownSources(): Promise<string> {
  const glob = new Bun.Glob("**/*.md");
  const sources: string[] = [];
  for await (const path of glob.scan({ cwd: import.meta.dir, absolute: true })) {
    sources.push(await Bun.file(path).text());
  }
  return sources.join("\n");
}

const docs = await markdownSources();
const app = await Bun.file(new URL("./zh/app.md", import.meta.url)).text();
const faq = await Bun.file(new URL("./zh/faq.md", import.meta.url)).text();
const push = await Bun.file(new URL("./zh/push.md", import.meta.url)).text();

describe("user-facing documentation", () => {
  test("uses the same session hierarchy as the PWA", () => {
    for (const stale of ["按空间", "按类型", "吊销这台设备", "改标签名", "新建标签、分屏"]) {
      expect(docs).not.toContain(stale);
    }
    expect(app).toContain("按工作区");
    expect(app).toContain("按 Agent");
    expect(app).toContain("默认只展开第一组");
    expect(app).toContain("**会话名**");
    expect(app).toContain("**标签页名**");
    expect(app).toContain("**工作区名**");
    expect(app).toContain("点卡片进去");
    expect(app).toContain("长按");
    expect(app).not.toContain("| 管理 |");
    expect(app).not.toContain("| 这一格 |");
    expect(app).toContain("claude · pairfob");
    expect(app).toContain("**终端**");
    expect(app).toContain("不会拿内部 ID 当名称");
    expect(app).not.toContain("未命名会话");
    expect(app).not.toContain("工作区：…");
  });

  test("names Auto and the three concrete pane modes the same way the PWA does", () => {
    expect(app).toContain("| **自动** |");
    expect(app).toContain("| **控制** |");
    expect(app).toContain("| **终端** |");
    expect(app).toContain("| **对话** |");
    expect(app).toContain("| 模式 | 自动、控制、终端（vim / TUI）、对话");
    expect(app).toContain("| 输入与显示 |");
    expect(app).not.toContain("更早的输出");
    expect(app).not.toContain("给 Agent 发任务");
    expect(app).not.toContain("铺满全屏");
    expect(docs).not.toContain("| Agent | 给 Agent 发任务 |");
    expect(app).toContain("**模式**：点开会话时默认用 **自动**");
    expect(app).not.toContain("完整终端");
    expect(app).not.toContain("会话顶栏会直接显示 **历史**");
    expect(app).not.toContain("| 画面 |");
    expect(app).toContain("**新建** 在电脑支持时出现：手机上在右下角");
    expect(app).not.toContain("顶部「新建」");
    expect(app).toContain("**画板**");
    expect(app).toContain("看标签页布局");
    expect(app).toContain("**会话操作**");
    expect(app).toContain("查看文件与更改");
    expect(app).toContain("订阅余量");
    expect(app).toContain("更新电脑端");
    expect(app).toContain("发给 Agent");
    expect(docs).not.toContain("＋ 新建会话");
    expect(docs).not.toContain("不展示思维链");
    expect(docs).not.toContain("两个按钮");
    expect(docs).not.toContain("选项会抬成可点的按钮");
    expect(docs).not.toContain("对话框可点");
  });

  test("matches the current PWA list, send button and settings", async () => {
    const appEn = await Bun.file(new URL("./app.md", import.meta.url)).text();
    // Grouping lives on the list's Workspace button, default by workspace; opens order the list.
    expect(app).toContain("**分组方式**");
    expect(app).toContain("状态变化不会挪动位置");
    expect(app).not.toContain("**会话列表**：分组方式");
    expect(app).toContain("| 本轮结束 |");
    expect(app).not.toContain("| 完成 |");
    // Send button states follow session-stop.ts sendKind.
    expect(app).toContain("**发送**");
    expect(app).toContain("**停止**");
    expect(app).toContain("**强制停止**");
    expect(app).toContain("**回车键发送**");
    expect(app).not.toContain("点它可以切换到别的会话");
    expect(app).not.toContain("在输入框上方直接切换");
    expect(appEn).toContain("**Group by**");
    expect(appEn).toContain("**Turn finished**");
    expect(appEn).toContain("**Force stop**");
    expect(appEn).toContain("**Return key sends**");
    expect(appEn).not.toContain("tap to switch sessions");
    // Attachments ride along with Send; there is no separate Upload / Insert step.
    expect(app).toContain("**不带它发送**");
    expect(app).not.toContain("**插入全部路径**");
    expect(appEn).toContain("**Send without them**");
    expect(appEn).not.toContain("**Insert all paths**");
  });

  test("covers the wide layout and the device-neutral labels", async () => {
    const appEn = await Bun.file(new URL("./app.md", import.meta.url)).text();
    const pair = await Bun.file(new URL("./zh/pair.md", import.meta.url)).text();
    const pairEn = await Bun.file(new URL("./pair.md", import.meta.url)).text();
    // Labels the PWA no longer shows (i18n-zh.ts / i18n-en.ts and the split tables).
    for (const stale of ["这台手机的配对", "接管了这台手机", "适应屏幕", "关闭这个工作区", "关闭整个标签页", "左栏顶部一排"]) {
      expect(docs).not.toContain(stale);
    }
    for (const stale of ["Unpair this phone", "took over this phone", "Fit screen", "Close this workspace", "Close the whole tab"]) {
      expect(docs).not.toContain(stale);
    }
    // Width tiers follow shared/ui/dom/width-tier.ts: 720 / 900 / 1200.
    expect(app).toContain("## 平板和桌面浏览器");
    expect(app).toContain("| 720–899px |");
    expect(app).toContain("| 900–1199px |");
    expect(app).toContain("| 1200px 以上 | 三栏：列表、会话、文件与更改 |");
    expect(app).toContain("最底下是 **画板** 和 **设置**");
    expect(app).toContain("**解除这台设备的配对**");
    expect(app).toContain("**屏幕键盘回车发送**");
    expect(app).toContain("**整页打开**");
    expect(appEn).toContain("## Tablets and desktop browsers");
    expect(appEn).toContain("| 1200px and up | Three columns: list, session, files and changes |");
    expect(appEn).toContain("**Unpair this device**");
    expect(appEn).toContain("**On-screen Return sends**");
    expect(appEn).toContain("**Open as a full page**");
    // A mouse gets the typed code on the page; scanning stays first on touch.
    expect(pair).toContain("用鼠标的桌面浏览器直接给输入框");
    expect(pairEn).toContain("A desktop browser with a mouse shows the code field on the page and no scan.");
  });

  test("describes empty sessions without claiming Herdr is offline", () => {
    expect(app).toContain("已连接但列表为空时，说明 Herdr 里还没有会话");
    expect(app).toContain("只有页面明确显示 **电脑上的 Herdr 没在运行** 时");
  });

  test("names GitHub Issues as the public feedback channel", async () => {
    const faqEn = await Bun.file(new URL("./faq.md", import.meta.url)).text();
    expect(faq).toContain("https://github.com/arronKler/pairfob/issues/new");
    expect(faqEn).toContain("https://github.com/arronKler/pairfob/issues/new");
    expect(faq).toContain("安全漏洞请走");
    expect(faqEn).toContain("GitHub Security Advisories");
  });

  test("documents the three network route choices on the computer page", () => {
    expect(app).toContain("**网络路线**");
    expect(app).toContain("**自动** / **仅 P2P** / **仅 Relay**");
    expect(app).toContain("**语言**");
    expect(app).toContain("**置顶**");
    expect(app).toContain("**取消置顶**");
  });

  test("covers P2P path, pinning, and Pairfob language across the rest of the docs", async () => {
    const glossary = await Bun.file(new URL("./zh/glossary.md", import.meta.url)).text();
    const security = await Bun.file(new URL("./zh/security.md", import.meta.url)).text();
    const troubleshoot = await Bun.file(new URL("./zh/troubleshoot.md", import.meta.url)).text();
    expect(glossary).toContain("| P2P |");
    expect(glossary).toContain("| 网络路线 |");
    expect(glossary).not.toContain("系统键盘。默认模式");
    expect(faq).toContain("P2P 直连失败了怎么办");
    expect(faq).toContain("**网络路线** 改成 **仅 Relay**");
    expect(faq).toContain("设置 → 语言");
    expect(troubleshoot).toContain("暂时无法建立 P2P，已继续使用 Relay");
    expect(troubleshoot).toContain("当前站点未开放 P2P");
    expect(troubleshoot).toContain("会立刻再试");
    expect(troubleshoot).toContain("没有 TURN");
    expect(security).toContain("走 P2P 直连时");
    expect(security).toContain("公网地址");
  });

  test("documents the shipped multi-computer flow", () => {
    expect(faq).toContain("设置 → 切换电脑 → 添加电脑");
    expect(faq).toContain("多台电脑分别保存一条配对凭证");
    expect(faq).not.toContain("一台设备的浏览器配置对应一次配对、一头电脑");
  });

  test("install is a grantless one-liner", async () => {
    const start = await Bun.file(new URL("./start.md", import.meta.url)).text();
    const install = await Bun.file(new URL("./install.md", import.meta.url)).text();
    const zhStart = await Bun.file(new URL("./zh/start.md", import.meta.url)).text();
    const zhInstall = await Bun.file(new URL("./zh/install.md", import.meta.url)).text();
    const devices = await Bun.file(new URL("./zh/devices.md", import.meta.url)).text();
    expect(start).toContain("curl -fsSL https://pairfob.com/install.sh | sh");
    expect(start).not.toContain("sh -s -- --grant");
    expect(zhStart).not.toContain("sh -s -- --grant");
    expect(install).toContain("curl -fsSL https://pairfob.com/install.sh | sh");
    expect(install).toContain("https://github.com/arronKler/pairfob");
    expect(zhInstall).toContain("https://github.com/arronKler/pairfob");
    expect(install).not.toContain("sh -s -- --grant jg_");
    expect(faq).toContain("curl -fsSL https://pairfob.com/install.sh | sh");
    expect(devices).toContain("curl -fsSL https://pairfob.com/install.sh | sh");
    expect(docs).not.toContain("A one-time join grant");
    expect(docs).not.toContain("Get my install command");
    expect(docs).not.toContain("获取我的安装命令");
    expect(docs).not.toContain("安装码");
    expect(docs).not.toContain("交换机");
    expect(docs).not.toContain("switchboard");
  });

  test("does not offer self-hosting", () => {
    expect(docs).not.toContain("自托管");
    expect(docs).not.toContain("Self-hosting");
    expect(docs).not.toContain("/self-host");
  });

  test("names the official instance and Apache-2.0", async () => {
    const faqEn = await Bun.file(new URL("./faq.md", import.meta.url)).text();
    const indexZh = await Bun.file(new URL("./zh/index.md", import.meta.url)).text();
    const indexEn = await Bun.file(new URL("./index.md", import.meta.url)).text();
    expect(faq).toContain("官方实例");
    expect(faq).toContain("Apache-2.0");
    expect(faq).toContain("https://github.com/arronKler/pairfob");
    expect(faq).not.toContain("新电脑登记随时可能关上");
    expect(faqEn).toContain("official instance");
    expect(faqEn).toContain("Apache-2.0");
    expect(faqEn).toContain("https://github.com/arronKler/pairfob");
    expect(faqEn).not.toContain("New computer setup can close");
    expect(indexZh).not.toContain("官方实例");
    expect(indexEn).not.toContain("Official instance");
    expect(indexZh).not.toContain("不适合当什么");
    expect(indexEn).not.toContain("Who it is not for");
  });

  test("design section stays a product overview", () => {
    expect(docs).not.toContain("能力从哪来");
    expect(docs).not.toContain("怎么接起来");
    expect(docs).not.toContain("Where capabilities come from");
    expect(docs).not.toContain("How it is wired");
    expect(docs).not.toContain("GetConfig");
    expect(docs).not.toContain("SPAKE");
    expect(docs).not.toContain("pairfob.v1");
    expect(docs).not.toContain("pairfob.v2");
  });

  test("documents notification transitions and deep-link behavior", () => {
    expect(push).toContain("Agent **等你处理**或从工作中变成**完成**时");
    expect(push).toContain("完成通知只认 `working → done`");
    expect(push).toContain("那台电脑的那个会话");
    expect(push).toContain("不会补发旧通知");
  });

  test("English docs quote English Pairfob labels, not Chinese chrome", async () => {
    const glob = new Bun.Glob("*.md");
    const chunks: string[] = [];
    for await (const path of glob.scan({ cwd: import.meta.dir, absolute: true })) {
      chunks.push(await Bun.file(path).text());
    }
    const en = chunks.join("\n").replaceAll("中文", "");
    expect(en).not.toMatch(/[\u4e00-\u9fff]/);
    const appEn = await Bun.file(new URL("./app.md", import.meta.url)).text();
    const pairEn = await Bun.file(new URL("./pair.md", import.meta.url)).text();
    const faqEn = await Bun.file(new URL("./faq.md", import.meta.url)).text();
    expect(appEn).toContain("**Settings**");
    expect(appEn).toContain("**Board**");
    expect(appEn).toContain("**Tab layout**");
    expect(appEn).toContain("**Pin to top**");
    expect(appEn).toContain("**Needs you**");
    expect(appEn).toContain("| **Control** |");
    expect(appEn).toContain("**Network route**");
    expect(appEn).toContain("**Browse files and changes**");
    expect(appEn).toContain("**Subscription quota:**");
    expect(appEn).toContain("**Update computer**");
    expect(appEn).toContain("**Send to agent**");
    expect(appEn).not.toContain("tappable buttons");
    expect(appEn).not.toContain("Dialogs are tappable");
    expect(appEn).not.toContain("The app chrome is currently Chinese");
    expect(pairEn).toContain("**Connect your computer**");
    expect(pairEn).toContain("**Scan to connect**");
    expect(pairEn).not.toContain("The pairing page copy is Chinese");
    expect(faqEn).toContain("Settings → Language");
    expect(faqEn).toContain("Settings → Switch computer → Add a computer");
  });

  test("lock screen and lid-close are distinct, and sleep cannot be woken", async () => {
    const faqEn = await Bun.file(new URL("./faq.md", import.meta.url)).text();
    const continueZh = await Bun.file(new URL("./zh/continue.md", import.meta.url)).text();
    const continueEn = await Bun.file(new URL("./continue.md", import.meta.url)).text();
    expect(faq).toContain("锁屏或合盖之后还能用吗");
    expect(faq).toContain("锁屏可以");
    expect(faq).toContain("唤不醒已经睡着的电脑");
    expect(faq).not.toContain("电脑合盖之后还能用吗");
    expect(faqEn).toContain("Does locking the screen or closing the lid still work?");
    expect(faqEn).toContain("Locking the screen is fine");
    expect(faqEn).toContain("cannot wake a sleeping computer");
    expect(faqEn).not.toContain("Does closing the lid still work?");
    expect(continueZh).toContain("可以锁屏");
    expect(continueZh).toContain("合盖塞进包里不是 Pairfob 的场景");
    expect(continueEn).toContain("Lock the screen if you want");
    expect(continueEn).toContain("Closing the lid in a bag is not a Pairfob scenario");
  });
});
