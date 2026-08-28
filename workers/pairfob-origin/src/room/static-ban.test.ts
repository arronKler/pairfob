import { describe, expect, test } from "bun:test";

describe("hibernation static bans", () => {
  test("src/room has no server.accept, setTimeout, or setInterval", async () => {
    const dir = import.meta.dir;
    const glob = new Bun.Glob("*.ts");
    const hits: string[] = [];
    for await (const path of glob.scan(dir)) {
      if (path.endsWith(".test.ts")) continue;
      const text = await Bun.file(dir + "/" + path).text();
      if (/server\.accept\s*\(/.test(text)) hits.push(path + ": server.accept");
      if (/\bsetTimeout\s*\(/.test(text)) hits.push(path + ": setTimeout");
      if (/\bsetInterval\s*\(/.test(text)) hits.push(path + ": setInterval");
    }
    expect(hits).toEqual([]);
  });
});
