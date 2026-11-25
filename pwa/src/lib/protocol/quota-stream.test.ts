import { expect, test } from "bun:test";
import { QuotaStream } from "./quota-stream";
import { AgentQuotaRPC } from "./agent-quota-rpc";
import { ProtocolError } from "./errors";
import { quotaAccount } from "../../../test-support/quota";
import { quotaAccountToWire } from "../agent-quota-v2";

const codex = quotaAccountToWire(quotaAccount({ provider: "codex" }));
const copilot = quotaAccountToWire(quotaAccount({ provider: "copilot" }));

test("compact completion restores source order including future providers", () => {
  const stream = new QuotaStream();
  stream.read({ items: [copilot, { provider: "future", id: "future" }], done: false });
  const final = stream.read({ items: [codex], done: true, order: ["codex", "future", "copilot"] });
  expect(final.report.accounts.map(a => a.id)).toEqual(["codex", "copilot"]);
  expect(final.report.unknown).toBe(1);
  expect(final.done).toBeTrue();
  expect(new QuotaStream().read({ items: [], done: true, order: [] }).report.accounts).toEqual([]);
});

test("compact completion rejects missing, duplicated and invented accounts", () => {
  for (const final of [
    { items: [], done: true, order: [] },
    { items: [], done: true, order: ["copilot"] },
    { items: [codex], done: true, order: ["codex", "codex"] },
    { items: [copilot], done: true, order: ["codex", "codex"] },
    { items: [], done: false, order: ["codex"] },
    { items: [], done: true, order: null },
  ]) {
    const stream = new QuotaStream();
    stream.read({ items: [codex], done: false });
    expect(() => stream.read(final)).toThrow(ProtocolError);
  }
});

test("compact negotiation retries empty params once and remembers per connection", async () => {
  const reader = new AgentQuotaRPC();
  const requests: unknown[] = [];
  const rpc = async (_op: string, _progress?: unknown, params?: { compact: true }) => {
    requests.push(params ?? {});
    if (params) throw new ProtocolError("invalid_argument");
    return { items: [codex], done: true };
  };
  await reader.read(rpc);
  await reader.read(rpc);
  reader.reset();
  await reader.read(rpc);
  expect(requests).toEqual([{ compact: true }, {}, {}, { compact: true }, {}]);
});

test("an error after a partial result never replays the query", async () => {
  let calls = 0;
  await expect(new AgentQuotaRPC().read(async (_op, accept) => {
    calls++;
    accept!({ items: [codex], done: false });
    throw new ProtocolError("invalid_argument");
  })).rejects.toMatchObject({ code: "invalid_argument" });
  expect(calls).toBe(1);
});

test("the RPC reader uses compact mode and assembles its final manifest", async () => {
  const report = await new AgentQuotaRPC().read(async (_op, accept, params) => {
    expect(params).toEqual({ compact: true });
    expect(accept!({ items: [copilot], done: false })).toBeTrue();
    const final = { items: [codex], done: true, order: ["codex", "copilot"] };
    expect(accept!(final)).toBeFalse();
    return final;
  });
  expect(report.accounts.map(a => a.id)).toEqual(["codex", "copilot"]);
});
