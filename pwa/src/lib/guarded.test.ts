import { describe, expect, test } from "bun:test";
import { guardedReply, promptGuard, visibleHas, type EnterGuard, type GuardedScreen } from "./guarded";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function screen(text: string, hash = HASH_A): GuardedScreen {
  return { text, hash };
}

describe("guardedReply", () => {
  test("sends each mutation once and binds Enter to the confirmed screen", async () => {
    let textSends = 0;
    let enterGuard: EnterGuard | null = null;
    const reads = [screen("❯ "), screen("❯ hello-pairfob", HASH_B)];
    const result = await guardedReply({
      text: "hello-pairfob",
      sendText: async () => {
        textSends += 1;
      },
      read: async () => reads.shift()!,
      sendEnter: async (guard) => {
        enterGuard = guard;
      },
    });

    expect(result).toBe("sent");
    expect(textSends).toBe(1);
    expect(enterGuard).toEqual({ expectedPrompt: "hello-pairfob", expectedSignature: HASH_B });
  });

  test("retries only pane reads until the typed text appears", async () => {
    let reads = 0;
    let textSends = 0;
    let enters = 0;
    const result = await guardedReply({
      text: "hello-pairfob",
      sendText: async () => {
        textSends += 1;
      },
      read: async () => {
        reads += 1;
        if (reads < 3) return screen("❯ ");
        return screen("❯ hello-pairfob", HASH_B);
      },
      sendEnter: async () => {
        enters += 1;
      },
      wait: async () => {},
      deadlineMs: 10_000,
    });

    expect(result).toBe("sent");
    expect(reads).toBe(3);
    expect(textSends).toBe(1);
    expect(enters).toBe(1);
  });

  test("keeps confirming beyond the old five-second read budget", async () => {
    let reads = 0;
    const result = await guardedReply({
      text: "hello-pairfob",
      sendText: async () => {},
      read: async () => {
        reads += 1;
        return reads < 48 ? screen("❯ ") : screen("❯ hello-pairfob", HASH_B);
      },
      sendEnter: async () => {},
      wait: async () => {},
      deadlineMs: 60_000,
    });

    expect(result).toBe("sent");
    expect(reads).toBe(48);
  });

  test("recovers from transient post-text read failures without replaying either mutation", async () => {
    let reads = 0;
    let textSends = 0;
    let enters = 0;
    const result = await guardedReply({
      text: "hello-pairfob",
      sendText: async () => {
        textSends += 1;
      },
      read: async () => {
        reads += 1;
        if (reads === 1) return screen("❯ ");
        if (reads < 4) throw new Error("temporarily disconnected");
        return screen("❯ hello-pairfob", HASH_B);
      },
      retryRead: () => true,
      sendEnter: async () => {
        enters += 1;
      },
      wait: async () => {},
      deadlineMs: 60_000,
    });

    expect(result).toBe("sent");
    expect(reads).toBe(4);
    expect(textSends).toBe(1);
    expect(enters).toBe(1);
  });

  test("does not hide a permanent post-text read failure", async () => {
    let reads = 0;
    await expect(
      guardedReply({
        text: "hello-pairfob",
        sendText: async () => {},
        read: async () => {
          reads += 1;
          if (reads === 1) return screen("❯ ");
          throw new Error("pane disappeared");
        },
        retryRead: () => false,
        sendEnter: async () => {},
      }),
    ).rejects.toThrow("pane disappeared");
  });

  test("stalls after a bounded number of reads without retrying a mutation", async () => {
    let reads = 0;
    let textSends = 0;
    let enters = 0;
    const result = await guardedReply({
      text: "hello-pairfob",
      sendText: async () => {
        textSends += 1;
      },
      read: async () => {
        reads += 1;
        return screen("password:");
      },
      sendEnter: async () => {
        enters += 1;
      },
      wait: async () => {},
      deadlineMs: 10_000,
      maxReads: 3,
    });

    expect(result).toBe("stalled");
    expect(reads).toBe(4); // one baseline plus three confirmation reads
    expect(textSends).toBe(1);
    expect(enters).toBe(0);
  });

  test("does not accept text that was already present before SendText", async () => {
    let enters = 0;
    const reads = [screen("Continue? yes"), screen("status changed\nContinue? yes", HASH_B)];
    const result = await guardedReply({
      text: "yes",
      sendText: async () => {},
      read: async () => reads.shift()!,
      sendEnter: async () => {
        enters += 1;
      },
      deadlineMs: 0,
      maxReads: 1,
    });

    expect(result).toBe("stalled");
    expect(enters).toBe(0);
  });

  test("accepts repeated text only when its visible occurrence count increases", async () => {
    let enters = 0;
    const reads = [screen("old hello"), screen("old hello\n❯ hello", HASH_B)];
    const result = await guardedReply({
      text: "hello",
      sendText: async () => {},
      read: async () => reads.shift()!,
      sendEnter: async () => {
        enters += 1;
      },
    });

    expect(result).toBe("sent");
    expect(enters).toBe(1);
  });

  test("supports a bounded expected suffix while sending the full text", async () => {
    let sent = "";
    let guard: EnterGuard | null = null;
    const text = `${"discard-".repeat(600)}hello-pairfob`;
    const visibleSuffix = Array.from(text).slice(-4096).join("");
    const reads = [screen("❯ "), screen(`❯ ${visibleSuffix}`, HASH_B)];
    const result = await guardedReply({
      text,
      sendText: async (text) => {
        sent = text;
      },
      read: async () => reads.shift()!,
      sendEnter: async (value) => {
        guard = value;
      },
    });

    expect(result).toBe("sent");
    expect(sent).toBe(text);
    expect(guard).toEqual({ expectedPrompt: visibleSuffix, expectedSignature: HASH_B });
  });

  test("confirms long input from a newly visible cursor-side tail", async () => {
    let guard: EnterGuard | null = null;
    const text = `explain-${"context-".repeat(30)}cursor-proof-1234567890`;
    const visibleTail = Array.from(text).slice(-32).join("");
    const reads = [screen("❯ "), screen(`❯ …${visibleTail}`, HASH_B)];
    const result = await guardedReply({
      text,
      sendText: async () => {},
      read: async () => reads.shift()!,
      sendEnter: async (value) => {
        guard = value;
      },
    });

    expect(result).toBe("sent");
    expect(guard).toEqual({ expectedPrompt: visibleTail, expectedSignature: HASH_B });
  });

  test("does not accept an unchanged visible tail from before SendText", async () => {
    let enters = 0;
    const text = `explain-${"context-".repeat(30)}cursor-proof-1234567890`;
    const visibleTail = Array.from(text).slice(-32).join("");
    const reads = [screen(`old ${visibleTail}`), screen(`status changed\nold ${visibleTail}`, HASH_B)];
    const result = await guardedReply({
      text,
      sendText: async () => {},
      read: async () => reads.shift()!,
      sendEnter: async () => {
        enters += 1;
      },
      deadlineMs: 0,
      maxReads: 1,
    });

    expect(result).toBe("stalled");
    expect(enters).toBe(0);
  });

  test("rejects a missing or malformed screen hash", async () => {
    let textSends = 0;
    await expect(
      guardedReply({
        text: "hello",
        sendText: async () => {
          textSends += 1;
        },
        read: async () => ({ text: "❯ " }),
        sendEnter: async () => {},
      }),
    ).rejects.toThrow("valid screen hash");
    expect(textSends).toBe(0);
  });

  test("stalls safely if a post-mutation read has no usable hash", async () => {
    let reads = 0;
    let enters = 0;
    const result = await guardedReply({
      text: "hello",
      sendText: async () => {},
      read: async () => {
        reads += 1;
        return reads === 1 ? screen("❯ ") : { text: "❯ hello" };
      },
      sendEnter: async () => {
        enters += 1;
      },
    });
    expect(result).toBe("stalled");
    expect(enters).toBe(0);
  });

  test("never retries Enter after the guarded mutation fails", async () => {
    let enters = 0;
    const reads = [screen("❯ "), screen("❯ hello", HASH_B)];
    await expect(
      guardedReply({
        text: "hello",
        sendText: async () => {},
        read: async () => reads.shift()!,
        sendEnter: async () => {
          enters += 1;
          throw new Error("stale screen");
        },
      }),
    ).rejects.toThrow("stale screen");
    expect(enters).toBe(1);
  });

  test("cancels before SendText when the user left during the baseline read", async () => {
    let textSends = 0;
    const result = await guardedReply({
      text: "hello",
      isActive: () => false,
      sendText: async () => {
        textSends += 1;
      },
      read: async () => screen("❯ "),
      sendEnter: async () => {},
    });
    expect(result).toBe("cancelled");
    expect(textSends).toBe(0);
  });

  test("withholds Enter when the user leaves after text was sent", async () => {
    let active = true;
    let enters = 0;
    const result = await guardedReply({
      text: "hello",
      isActive: () => active,
      sendText: async () => {
        active = false;
      },
      read: async () => screen("❯ "),
      sendEnter: async () => {
        enters += 1;
      },
    });
    expect(result).toBe("stalled");
    expect(enters).toBe(0);
  });
});

describe("visibleHas / promptGuard", () => {
  test("recognizes common soft wraps without deleting meaningful spaces", () => {
    expect(visibleHas("❯ hello pairfob\nworld", "hello pairfob world")).toBe(true);
    expect(visibleHas("❯ hello pair\nfob", "hello pairfob")).toBe(true);
    expect(visibleHas("❯ delete/tmp", "delete /tmp")).toBe(false);
    expect(visibleHas("password:", "hello-pairfob")).toBe(false);
  });

  test("uses a substantial literal from a wrapped line", () => {
    const display = "❯ hello pairfob\nworld";
    const guard = promptGuard(display, "hello pairfob world");
    expect(guard.length).toBeGreaterThanOrEqual(12);
    expect(display).toContain(guard);
  });

  test("does not shrink a long guard to a common short fragment", () => {
    expect(promptGuard("alpha\nbravo\ncharlie", "alpha bravo charlie")).toBe("");
    expect(promptGuard("only d is visible", "a long command ending in d")).toBe("");
  });

  test("requires the full literal for short input", () => {
    expect(promptGuard("Continue? yes", "yes")).toBe("yes");
    expect(promptGuard("Continue? y", "yes")).toBe("");
  });

  test("bounds the daemon guard by Unicode code points", () => {
    const input = "😀".repeat(4097);
    const visible = "😀".repeat(4096);
    const guard = promptGuard(visible, input);
    expect(Array.from(guard)).toHaveLength(4096);
    expect(guard).not.toContain("�");
  });
});
