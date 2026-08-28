import { describe, expect, test } from "bun:test";
import { ROOM_DDL } from "./schema.ts";

describe("Room SQLite schema", () => {
  test("uses an append-only migration table instead of unsupported PRAGMA state", () => {
    const sql = ROOM_DDL.join("\n");
    expect(sql).not.toContain("PRAGMA user_version");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS _sql_schema_migrations");
    expect(ROOM_DDL.at(-1)).toContain("INSERT OR IGNORE INTO _sql_schema_migrations");
  });
});
