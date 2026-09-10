import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import type { WorkspaceSnapshot } from "./model";

await resetTestDOM();
const { DiffDetail, DiffScroller } = await import("./diff");
const { emptyWorkspaceModel } = await import("./model");

function diffSnapshot(path: string): WorkspaceSnapshot {
  return {
    ...emptyWorkspaceModel(),
    pendingReveal: false,
    notesEpoch: 0,
    view: "diff",
    detailPath: path,
    diff: {
      path, layer: "worktree", patch: "@@ -1 +1 @@\n-old\n+new\n",
      additions: 1, deletions: 1, binary: false, truncated: false, revision: "a".repeat(64),
    },
  };
}

describe("DiffScroller key lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(key: string, child: ReactNode = "body") {
    act(() => {
      root.render(<DiffScroller diffKey={key}>{child}</DiffScroller>);
    });
    return host.querySelector<HTMLElement>(".workspace-diff")!;
  }

  test("changing key on the same mounted node does not restore the previous scroll", () => {
    const el = render("a.ts:worktree");
    el.scrollTop = 99;
    el.scrollLeft = 8;
    const next = render("b.ts:worktree");
    expect(next).toBe(el);
    expect(next.dataset.diffKey).toBe("b.ts:worktree");
    expect(next.scrollTop).toBe(0);
    expect(next.scrollLeft).toBe(0);
  });

  test("same-key updates keep the current scroll", () => {
    const el = render("a.ts:worktree", "one");
    el.scrollTop = 40;
    el.scrollLeft = 6;
    const next = render("a.ts:worktree", "two");
    expect(next).toBe(el);
    expect(next.scrollTop).toBe(40);
    expect(next.scrollLeft).toBe(6);
  });

  test("same-key unmount/remount restores the captured scroll", () => {
    const el = render("a.ts:worktree");
    el.scrollTop = 51;
    el.scrollLeft = 3;
    act(() => { root.render(null); });
    const next = render("a.ts:worktree");
    expect(next.scrollTop).toBe(51);
    expect(next.scrollLeft).toBe(3);
  });

  test("same mounted DiffDetail a.ts to b.ts does not keep scroll under the new key", () => {
    act(() => { root.render(<DiffDetail snapshot={diffSnapshot("a.ts")} onEditNote={() => {}} />); });
    const before = host.querySelector<HTMLElement>(".workspace-diff")!;
    before.scrollTop = 99;
    before.scrollLeft = 8;
    before.dispatchEvent(new window.Event("scroll"));
    act(() => { root.render(<DiffDetail snapshot={diffSnapshot("b.ts")} onEditNote={() => {}} />); });
    const after = host.querySelector<HTMLElement>(".workspace-diff")!;
    expect(after).toBe(before);
    expect(after.dataset.diffKey).toBe("b.ts:worktree");
    expect(after.scrollTop).toBe(0);
    expect(after.scrollLeft).toBe(0);
  });
});
