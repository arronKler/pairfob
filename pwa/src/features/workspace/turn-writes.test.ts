import { beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { loadTurnWrites, rereadTurnWrites, resetTurnWrites, subscribeTurnWrites, turnWrites, workspacePathOf } from "./turn-writes";

/**
 * The files the agent's current turn wrote, as paths of the workspace on
 * screen. The tools name them absolutely or relative to the agent's working
 * directory; what lies outside the workspace is not this list's to show.
 */

const ROOT = "/private/work/pairfob";
const CWD = "/work/pairfob";

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTurnWrites();
});

describe("a written path as a path of the workspace", () => {
  test("absolute under the root, or under the working directory the root resolves", () => {
    expect(workspacePathOf(`${ROOT}/src/app.ts`, ROOT, CWD)).toBe("src/app.ts");
    expect(workspacePathOf(`${CWD}/src/app.ts`, ROOT, CWD)).toBe("src/app.ts");
    expect(workspacePathOf(`${CWD}/./src/../README.md`, ROOT, CWD)).toBe("README.md");
  });

  test("relative to the working directory", () => {
    expect(workspacePathOf("src/app.ts", ROOT, CWD)).toBe("src/app.ts");
    expect(workspacePathOf("./src//lib/../app.ts", ROOT, CWD)).toBe("src/app.ts");
  });

  test("outside the workspace it is nothing", () => {
    expect(workspacePathOf("/etc/hosts", ROOT, CWD)).toBeNull();
    expect(workspacePathOf(`${ROOT}-other/app.ts`, ROOT, CWD)).toBeNull();
    expect(workspacePathOf("../sibling/app.ts", ROOT, CWD)).toBeNull();
    expect(workspacePathOf(`${ROOT}/src/../../escape.ts`, ROOT, CWD)).toBeNull();
    expect(workspacePathOf(ROOT, ROOT, CWD)).toBeNull();
    expect(workspacePathOf(".", ROOT, CWD)).toBeNull();
  });
});

describe("reading a pane's turn", () => {
  const session = (read?: (paneId: string) => Promise<string[] | null>) => ({ agentTurnWrites: read }) as never;

  test("keeps the files inside the workspace, each once, for that pane and root only", async () => {
    const live = session(async () => [`${ROOT}/src/app.ts`, "src/app.ts", "src/styles.scss", "/etc/hosts"]);
    await loadTurnWrites(live, "p1", ROOT, CWD);
    expect([...turnWrites("p1", ROOT)]).toEqual(["src/app.ts", "src/styles.scss"]);
    expect([...turnWrites("p2", ROOT)]).toEqual([]);
    expect([...turnWrites("p1", "/work/other")]).toEqual([]);
  });

  test("a daemon that cannot say, a pane without a transcript and a failed read all leave none", async () => {
    await loadTurnWrites(session(), "p1", ROOT, CWD);
    expect([...turnWrites("p1", ROOT)]).toEqual([]);
    await loadTurnWrites(session(async () => null), "p1", ROOT, CWD);
    expect([...turnWrites("p1", ROOT)]).toEqual([]);
    await loadTurnWrites(session(async () => { throw new Error("transcript_unavailable"); }), "p1", ROOT, CWD);
    expect([...turnWrites("p1", ROOT)]).toEqual([]);
  });

  test("another pane's read replaces it, and a slower older read never lands over a newer one", async () => {
    let release!: (paths: string[]) => void;
    const slow = session(() => new Promise<string[]>((resolve) => { release = resolve; }));
    const first = loadTurnWrites(slow, "p1", ROOT, CWD);
    await loadTurnWrites(session(async () => ["b.ts"]), "p2", ROOT, CWD);
    release(["a.ts"]);
    await first;
    expect([...turnWrites("p2", ROOT)]).toEqual(["b.ts"]);
    expect([...turnWrites("p1", ROOT)]).toEqual([]);
  });

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** What the list of sessions says of the pane's agent. */
  const setAgentStatus = (status: "idle" | "working" | "done") => replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "pairfob" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: CWD, agent: "codex", agent_status: status }],
  } as never);

  test("coming back to the changes reads the turn as it stands now", async () => {
    let written = ["a.ts"];
    let reads = 0;
    const live = session(async () => { reads++; return written; });
    await loadTurnWrites(live, "p1", ROOT, CWD);
    written = ["b.ts"];
    rereadTurnWrites();
    await flush();
    expect(reads).toBe(2);
    expect([...turnWrites("p1", ROOT)]).toEqual(["b.ts"]);
  });

  test("the agent starting or stopping work reads its turn again, while something lists it", async () => {
    setAgentStatus("idle");
    let written = ["a.ts"];
    let reads = 0;
    const live = session(async () => { reads++; return written; });
    await loadTurnWrites(live, "p1", ROOT, CWD);
    expect(reads).toBe(1);

    // Nothing on screen lists the turn's files: the session list changing reads nothing.
    setAgentStatus("working");
    await flush();
    expect(reads).toBe(1);

    const stop = subscribeTurnWrites(() => undefined);
    // A list that reports the status it already gave is not news.
    setAgentStatus("working");
    await flush();
    expect(reads).toBe(1);

    // The turn ends having written another file; that is when the list moves on.
    written = ["b.ts"];
    setAgentStatus("done");
    await flush();
    expect(reads).toBe(2);
    expect([...turnWrites("p1", ROOT)]).toEqual(["b.ts"]);

    // The same status again is no news.
    setAgentStatus("done");
    await flush();
    expect(reads).toBe(2);

    // And the next turn starts: the agent is working again.
    setAgentStatus("working");
    await flush();
    expect(reads).toBe(3);
    stop();
  });
});
