import { beforeEach, expect, test } from "bun:test";
import { resetTestDOM } from "../../test-support/boot-dom";
import { consoleURL, forgetConsole, readConsole, saveConsole } from "./recovery-console";

const host = { daemonId: "mac", fp: "key", deviceId: "phone" };
beforeEach(async () => { await resetTestDOM(); forgetConsole(host.daemonId); });

test("opens a user-entered HTTPS console without forwarding URL credentials", () => {
  expect(consoleURL(" https://Studio.EXAMPLE:443/guacamole/ ")?.href).toBe("https://studio.example/guacamole/");
  for (const input of ["http://mac", "//mac", "https:mac", "javascript:alert(1)", "https://u:p@mac",
    "https://mac/#flight", "https://mac/?token=x", "https://mac\\@other", "https://mac\n.example/"]) {
    expect(consoleURL(input)).toBeNull();
    expect(() => saveConsole(host, input)).toThrow();
  }
});

test("binds recovery to the paired computer, its key and this phone's pairing", () => {
  saveConsole(host, "https://studio.example/");
  expect(readConsole(host)).toBe("https://studio.example/");
  for (const other of [{ fp: "other" }, { daemonId: "other" }, { deviceId: "other" }]) {
    expect(readConsole({ ...host, ...other })).toBe("");
  }
  forgetConsole(host.daemonId);
  expect(readConsole(host)).toBe("");
});
