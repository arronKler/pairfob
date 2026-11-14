import { expect, test } from "bun:test";
import { AgentQuotaRPC } from "./agent-quota-rpc";
import { ProtocolError } from "./errors";
import { quotaAccount, quotaReport } from "../../../test-support/quota";
import { quotaAccountToWire } from "../agent-quota-v2";
import type { QuotaReport } from "../agent-quota-report";

const account = (id: "codex" | "copilot") => quotaAccountToWire(quotaAccount({ provider:id }));

test("deltas expose real samples while the final report retains authoritative ordering", async () => {
  const progress: QuotaReport[] = [];
  const report = await new AgentQuotaRPC().read(async (op, accept) => {
    expect(op).toBe("AgentQuotaStream");
    expect(accept!({items:[account("copilot")],done:false})).toBeTrue();
    expect(progress[0]!.accounts.map(a=>a.id)).toEqual(["copilot"]);
    expect(accept!({items:[account("codex")],done:false})).toBeTrue();
    const final = {items:[account("codex"),account("copilot")],done:true};
    expect(accept!(final)).toBeFalse();
    return final;
  }, part=>progress.push(part));
  expect(progress[1]!.accounts.map(a=>a.id)).toEqual(["copilot","codex"]);
  expect(report.accounts.map(a=>a.id)).toEqual(["codex","copilot"]);
});

test("old daemon fallback is remembered per connection and reset on reconnect", async () => {
  const reader = new AgentQuotaRPC(), ops: string[]=[];
  const rpc = async (op:string) => {
    ops.push(op);
    if(op==="AgentQuotaStream") throw new ProtocolError("unknown_op");
    return {items:[account("codex")]};
  };
  await reader.read(rpc); await reader.read(rpc); reader.reset(); await reader.read(rpc);
  expect(ops).toEqual(["AgentQuotaStream","AgentQuotaV2","AgentQuotaV2","AgentQuotaStream","AgentQuotaV2"]);
});

test("auth failures, timeouts and malformed streams never trigger fallback", async () => {
  for (const code of ["timeout","unpaired","rate_limited"]) {
    const ops:string[]=[];
    await expect(new AgentQuotaRPC().read(async op=>{ops.push(op);throw new ProtocolError(code);})).rejects.toMatchObject({code});
    expect(ops).toEqual(["AgentQuotaStream"]);
  }
  for(const invalid of [{items:[],done:1},{items:[],done:false,extra:true},{items:[],done:false},{items:[{provider:"codex"}],done:false}]) {
    await expect(new AgentQuotaRPC().read(async (_op,accept)=>{accept!(invalid);return invalid;})).rejects.toBeInstanceOf(ProtocolError);
  }
});

test("duplicate accounts and excessive deltas fail closed even without a listener", async () => {
  await expect(new AgentQuotaRPC().read(async (_op,accept)=>{
    accept!({items:[account("codex")],done:false});
    accept!({items:[account("codex")],done:false});
    return {items:[],done:true};
  })).rejects.toMatchObject({code:"bad_frame"});
  await expect(new AgentQuotaRPC().read(async (_op,accept)=>{
    for(let i=0;i<5;i++) accept!({items:[{provider:"future",id:String(i)}],done:false});
    return {items:[],done:true};
  })).rejects.toMatchObject({code:"bad_message"});
});

test("unknown providers count cumulatively without hiding supported accounts",async()=>{
  let partial:QuotaReport=quotaReport();
  await new AgentQuotaRPC().read(async(_op,accept)=>{
    accept!({items:[{provider:"future"}],done:false});
    accept!({items:[account("codex")],done:false});
    return {items:[{provider:"future"},account("codex")],done:true};
  },part=>{partial=part;});
  expect(partial.unknown).toBe(1); expect(partial.accounts).toHaveLength(1);
});
