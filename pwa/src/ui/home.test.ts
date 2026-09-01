import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./home.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../live-operations.ts", import.meta.url)).text();

describe("home new session", () => {
  test("create conversation is not gated on advertised agent kinds", () => {
    expect(source).not.toContain("state.agentKinds.length");
    expect(source).not.toContain("电脑没有提供可用的 Agent 类型");
    expect(source).toContain("create.disabled = state.operationBusy || !state.live?.isConnected()");
    expect(source).toContain(
      'button(state.operationBusy ? t("home.creating") : t("home.new"), "topbar-create", startNewConversation)',
    );
    expect(source).not.toContain("home-create");
    expect(source).not.toContain("＋ 新建会话");
    expect(liveSource).toContain("askCreateConversation(state.agentKinds, defaults)");
    expect(liveSource).not.toContain("!state.agentKinds.length");
  });
});

describe("home chrome", () => {
  test("the session list does not carry a product-feedback link", () => {
    expect(source).not.toContain("遇到问题");
    expect(source).not.toContain("issues/new");
    expect(source).not.toContain("homeFeedback");
  });

  test("app notices sit above the session cards", () => {
    const home = source.slice(source.indexOf("export function renderHome"));
    const noticeAt = home.indexOf("appendNotice(root)");
    const listAt = home.indexOf("fillHerdList(root)");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(noticeAt);
  });
});

describe("home pinned sessions", () => {
  test("cards mark pinned panes and pass pins into grouping", () => {
    expect(source).toContain("paneIsPinned");
    expect(source).toContain("pin-mark");
    expect(source).toContain("groupAgents(state.agents, state.listGroup, state.paneTouched, state.panePinned)");
    expect(source).toContain("group.id !== PINNED_GROUP_ID");
  });
});

describe("home grouped list", () => {
  test("grouped headings toggle and start with later groups collapsed", () => {
    expect(source).toContain("groupToggle");
    expect(source).toContain("syncGroupCollapsed");
    expect(source).toContain("toggleGroupCollapsed");
    expect(source).toContain("body.hidden = collapsed");
    expect(source).not.toContain("sectionTitle(group.title, group.items.length, grouped)");
  });
});
