import { describe, expect, test } from "bun:test";
import { t } from "../../lib/i18n";
import { openWorktreeTargetError, resizeAmountError, splitRatioError } from "./operation-ui";

describe("operation validation facade", () => {
  test("opening a Worktree requires exactly one target", () => {
    expect(openWorktreeTargetError("", "")).toBe(t("form.needPathOrBranch"));
    expect(openWorktreeTargetError("/repo/tree", "feature/tree")).toBe(t("form.pathXorBranch"));
    expect(openWorktreeTargetError("/repo/tree", "")).toBeNull();
    expect(openWorktreeTargetError("", "feature/tree")).toBeNull();
  });

  test("fraction validation includes only the allowed boundaries", () => {
    expect(splitRatioError("")).toBeNull();
    expect(splitRatioError("0.5")).toBeNull();
    expect(splitRatioError("0")).not.toBeNull();
    expect(splitRatioError("1")).not.toBeNull();
    expect(resizeAmountError("0.1")).toBeNull();
    expect(resizeAmountError("1")).toBeNull();
    expect(resizeAmountError("0")).not.toBeNull();
  });
});
