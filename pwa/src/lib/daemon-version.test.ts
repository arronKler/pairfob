import { expect, test } from "bun:test";
import { legacyBuild, newerRelease, releaseParts } from "./daemon-version";
test("numeric releases compare numerically and never downgrade unknown builds", () => {
  expect(newerRelease("2026-09-07.10", "2026-09-07.9")).toBeTrue();
  expect(newerRelease("v1.10.0", "1.9.0")).toBeTrue();
  for (const [a,b] of [["1.0.0","1.0.0"],["1.0.0","2.0.0"],["1.0.0","dev"],["1.0.0","1.0.0-rc1"],["2026-09-07.1","1.0.0"]]) expect(newerRelease(a,b)).toBeFalse();
  expect(releaseParts("<html>error</html>")).toBeNull();
  expect(legacyBuild("0.1.0")).toBeTrue();
  expect(legacyBuild("dev")).toBeFalse();
});
