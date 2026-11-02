import { beforeEach } from "bun:test";
import { setLang } from "../src/lib/i18n";

// A test that switches language must not change the default a later file sees.
beforeEach(() => {
  setLang("zh");
});