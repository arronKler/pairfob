import { describe, expect, test } from "bun:test";
import { t } from "./i18n";
import { openWorktreeTargetError, resizeAmountError, splitRatioError } from "./operation-ui";

const source = await Bun.file(new URL("./operation-ui.ts", import.meta.url)).text();

describe("operation form guidance", () => {
  test("opening a Worktree requires exactly one target", () => {
    expect(openWorktreeTargetError("", "")).toBe(t("form.needPathOrBranch"));
    expect(openWorktreeTargetError("/repo/tree", "feature/tree")).toBe(t("form.pathXorBranch"));
    expect(openWorktreeTargetError("/repo/tree", "")).toBeNull();
    expect(openWorktreeTargetError("", "feature/tree")).toBeNull();
    expect(source).toContain('t("form.pathEither")');
    expect(source).toContain('t("form.branchEither")');
  });

  test("creating a Worktree explains that an empty target is valid", () => {
    expect(source).toContain('t("form.worktreeBlank")');
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
    expect(source).toContain('title = kind === "resize" ? t("form.resizeTitle")');
    expect(source).toContain('t("form.wider")');
    expect(source).toContain('t("form.narrower")');
    expect(source).toContain('t("form.taller")');
    expect(source).toContain('t("form.shorter")');
    expect(source).toContain('direction: "up"');
    expect(source).toContain('direction: "down"');
    expect(source).toContain('t("form.swapLeft")');
    expect(source).toContain("PANE_RESIZE_STEP");
    expect(source).not.toContain("调整量（大于 0，最大 1）");
    expect(source).not.toContain("放大模式");
    expect(source).toContain('t("form.splitRight")');
    expect(source).toContain("ratio: 0.5");
    expect(source).toContain('t("form.splitHint")');
  });

  test("new sessions can omit an agent kind for a terminal pane", () => {
    expect(source).toContain('formDialog(t("form.newConversation")');
    expect(source).toContain('t("form.plainTerminal")');
    expect(source).toContain('t("form.noAgentKinds")');
    expect(source).toContain("...(agentKind ? { agent_kind: agentKind } : {})");
    expect(source).not.toContain("请选择 Agent。");
  });

  test("the submit action is primary and cancel is ghost", () => {
    expect(source).toContain('button(t("cancel"), "btn btn-small btn-ghost", close)');
    expect(source).toContain('node("button", "btn btn-small btn-primary", submitLabel)');
    expect(source).toContain("row.append(submit, cancel)");
  });

  test("invalid fields receive a specific message and focus target", () => {
    expect(source).toContain("validation.textContent = result.message");
    expect(source).toContain('target.setAttribute("aria-invalid", "true")');
    expect(source).not.toContain("请检查必填项和数值范围。");
  });
});
