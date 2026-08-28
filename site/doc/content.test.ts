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
    expect(app).toContain("会话 / 标签页 / 工作区");
    expect(app).toContain("claude · pairfob");
    expect(app).toContain("终端 · pairfob");
    expect(app).toContain("不会拿内部 ID 当名称");
    expect(app).not.toContain("未命名会话");
    expect(app).not.toContain("工作区：…");
  });

  test("names the three pane modes the same way the PWA does", () => {
    expect(app).toContain("| **控制** |");
    expect(app).toContain("| **终端** |");
    expect(app).toContain("| **对话** |");
    expect(app).toContain("| 模式 | 控制、终端（vim / TUI）、对话");
    expect(app).toContain("| 输入 |");
    expect(app).toContain("| 显示 |");
    expect(app).toContain("更早的输出");
    expect(app).not.toContain("给 Agent 发任务");
    expect(app).not.toContain("铺满全屏");
    expect(docs).not.toContain("| Agent | 给 Agent 发任务 |");
    expect(app).toContain("**模式**：点开会话时默认进 **控制** / **终端** / **对话**");
    expect(app).not.toContain("完整终端");
    expect(app).not.toContain("会话顶栏会直接显示 **历史**");
    expect(app).not.toContain("| 画面 |");
    expect(app).toContain("顶部「新建」");
    expect(docs).not.toContain("＋ 新建会话");
    expect(docs).not.toContain("不展示思维链");
  });

  test("describes empty sessions without claiming Herdr is offline", () => {
    expect(app).toContain("已连接但列表为空时，说明 Herdr 里还没有会话");
    expect(app).toContain("只有页面明确显示 Herdr 没有运行时");
  });

  test("documents the shipped multi-computer flow", () => {
    expect(faq).toContain("设置 → 添加另一台电脑");
    expect(faq).toContain("多台电脑分别保存一条配对凭证");
    expect(faq).not.toContain("一台设备的浏览器配置对应一次配对、一头电脑");
  });

  test("install is a grantless one-liner", async () => {
    const start = await Bun.file(new URL("./start.md", import.meta.url)).text();
    const install = await Bun.file(new URL("./install.md", import.meta.url)).text();
    const zhStart = await Bun.file(new URL("./zh/start.md", import.meta.url)).text();
    const devices = await Bun.file(new URL("./zh/devices.md", import.meta.url)).text();
    expect(start).toContain("curl -fsSL https://pairfob.com/install.sh | sh");
    expect(start).not.toContain("sh -s -- --grant");
    expect(zhStart).not.toContain("sh -s -- --grant");
    expect(install).toContain("curl -fsSL https://pairfob.com/install.sh | sh");
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

  test("documents notification transitions and deep-link behavior", () => {
    expect(push).toContain("Agent **等你处理**或从工作中变成**完成**时");
    expect(push).toContain("完成通知只认 `working → done`");
    expect(push).toContain("那台电脑的那个会话");
    expect(push).toContain("不会补发旧通知");
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
