import { parseQuotaAccounts } from "../agent-quota-v2";
import type { QuotaReport } from "../agent-quota-report";
import { ProtocolError } from "./errors";
import { exactKeys, isRecord } from "./session-message";

const fail = (): never => { throw new ProtocolError("bad_message", "订阅余量分批响应格式错误"); };

/** Validate full or compact streams before publishing any result. */
export class QuotaStream {
  private items: unknown[] = [];
  deltas = 0;

  read(value: unknown): { done: boolean; report: QuotaReport } {
    if (!isRecord(value) || !exactKeys(value, ["items", "done"], ["order"]) || typeof value.done !== "boolean"
      || !Array.isArray(value.items) || value.items.length > 64) return fail();
    if (!value.done) {
      if ("order" in value || ++this.deltas > 4 || !value.items.length || this.items.length + value.items.length > 64) return fail();
      this.items.push(...value.items);
      return { done: false, report: { ...parseQuotaAccounts({ items: this.items }), legacy: false } };
    }
    let items: unknown[] = value.items;
    if ("order" in value) {
      if (!Array.isArray(value.order) || value.order.length > 64) return fail();
      const all = [...this.items, ...items];
      if (all.length !== value.order.length) return fail();
      const indexed = new Map<string, unknown>();
      for (const item of all) {
        if (!isRecord(item) || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.id) || indexed.has(item.id)) return fail();
        indexed.set(item.id, item);
      }
      items = value.order.map(id => {
        if (typeof id !== "string" || !indexed.has(id)) return fail();
        const item = indexed.get(id);
        indexed.delete(id);
        return item;
      });
    }
    return { done: true, report: { ...parseQuotaAccounts({ items }), legacy: false } };
  }
}
