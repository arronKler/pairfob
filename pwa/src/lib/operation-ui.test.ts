import { describe, expect, test } from "bun:test";
import { openWorktreeTargetError, resizeAmountError, splitRatioError } from "./operation-ui";

const source = await Bun.file(new URL("./operation-ui.ts", import.meta.url)).text();

describe("operation form guidance", () => {
  test("opening a Worktree requires exactly one target", () => {
    expect(openWorktreeTargetError("", "")).toBe("请输入路径或分支。");
    expect(openWorktreeTargetError("/repo/tree", "feature/tree")).toBe("路径和分支只能填写一个。");
    expect(openWorktreeTargetError("/repo/tree", "")).toBeNull();
    expect(openWorktreeTargetError("", "feature/tree")).toBeNull();
    expect(source).toContain('kind === "open" ? "路径（二选一）"');
    expect(source).toContain('kind === "open" ? "分支（二选一）"');
  });

  test("creating a Worktree explains that an empty target is valid", () => {
    expect(source).toContain("路径和分支都留空时，电脑会自动生成 Worktree 的名称和路径。");
  });

  test("fraction labels and validation agree at their boundaries", () => {
    expect(splitRatioError("")).toBeNull();
    expect(splitRatioError("0.5")).toBeNull();
    expect(splitRatioError("0")).not.toBeNull();
    expect(splitRatioError("1")).not.toBeNull();
    expect(resizeAmountError("0.1")).toBeNull();
    expect(resizeAmountError("1")).toBeNull();
    expect(resizeAmountError("0")).not.toBeNull();
  });

  test("layout picks are phone actions, not protocol fields", () => {
    expect(source).toContain('title = kind === "resize" ? "让这一格大一点"');
    expect(source).toContain("加宽");
    expect(source).toContain("变窄");
    expect(source).toContain('label: "加高", choice: { kind: "resize", direction: "up"');
    expect(source).toContain('label: "变矮", choice: { kind: "resize", direction: "down"');
    expect(source).toContain("和左边对调");
    expect(source).toContain("PANE_RESIZE_STEP");
    expect(source).not.toContain("调整量（大于 0，最大 1）");
    expect(source).not.toContain("放大模式");
    expect(source).toContain("在右边再开一格");
    expect(source).toContain("ratio: 0.5");
    expect(source).toContain("手机一次只看其中一格，半屏时用铺满全屏");
  });

  test("new sessions can omit an agent kind for a terminal pane", () => {
    expect(source).toContain('formDialog("新建会话"');
    expect(source).toContain("纯终端（不启动 Agent）");
    expect(source).toContain("电脑没有可用的 Agent 类型，将创建纯终端会话。");
    expect(source).toContain("...(agentKind ? { agent_kind: agentKind } : {})");
    expect(source).not.toContain("请选择 Agent。");
  });

  test("the submit action is primary and cancel is ghost", () => {
    expect(source).toContain('button("取消", "btn btn-small btn-ghost", close)');
    expect(source).toContain('node("button", "btn btn-small btn-primary", submitLabel)');
    expect(source).toContain("row.append(submit, cancel)");
  });

  test("invalid fields receive a specific message and focus target", () => {
    expect(source).toContain("validation.textContent = result.message");
    expect(source).toContain('target.setAttribute("aria-invalid", "true")');
    expect(source).not.toContain("请检查必填项和数值范围。");
  });
});
