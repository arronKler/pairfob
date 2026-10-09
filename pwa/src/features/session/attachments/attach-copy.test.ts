import { afterEach, expect, test } from "bun:test";
import { setLang } from "../../../lib/i18n";
import { attachT } from "./attach-copy";

afterEach(() => { setLang("zh"); });

test("English counts one file and one path in the singular", () => {
  setLang("en");
  expect(attachT("tray.restored", { n: 1 })).toBe("1 file from last time did not finish");
  expect(attachT("tray.restored", { n: 2 })).toBe("2 files from last time did not finish");
  expect(attachT("tray.willAttach", { n: 1 })).toBe("Attaches 1 path on send");
  expect(attachT("tray.willAttach", { n: 3 })).toBe("Attaches 3 paths on send");
  // A key with no singular of its own keeps its one form.
  expect(attachT("tray.removeOne", { name: "a.png" })).toBe("Remove a.png");
});

test("Chinese has one form for every count", () => {
  setLang("zh");
  expect(attachT("tray.restored", { n: 1 })).toBe("上次 1 个文件没传完");
  expect(attachT("tray.restored", { n: 2 })).toBe("上次 2 个文件没传完");
});
