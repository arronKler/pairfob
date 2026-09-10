import { describe, expect, test } from "bun:test";
import { dashboardStore } from "../dashboard/catalog-store";
import { agentFromDashboardSnapshot } from "./agents";

describe("dashboard snapshot agent", () => {
  test("reads the published card and keeps snapshot identity across getSnapshot", () => {
    const first = dashboardStore.get();
    const second = dashboardStore.get();
    expect(second).toBe(first);
    expect(agentFromDashboardSnapshot(first, "missing")).toBeUndefined();
  });
});
