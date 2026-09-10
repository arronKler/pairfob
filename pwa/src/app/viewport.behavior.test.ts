import { Window } from "happy-dom";
import { expect, test } from "bun:test";
import { bindVisualViewport } from "./viewport";

test("pinch and pan preserve layout, while real keyboard and rotation resizes still notify", () => {
  const happy = new Window({ width: 390, height: 844 });
  const viewport = Object.assign(new happy.EventTarget(), { scale: 1, height: 844, offsetTop: 0 });
  Object.defineProperty(happy, "visualViewport", { value: viewport });
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = happy;
  globals.document = happy.document;
  happy.document.body.classList.add("lock");
  let scrolls = 0;
  happy.scrollTo = () => { scrolls++; };
  let resizes = 0;
  bindVisualViewport(() => { resizes++; });
  const baselineScrolls = scrolls;
  const root = happy.document.documentElement;
  const send = (type: string) => viewport.dispatchEvent(new happy.Event(type));

  viewport.scale = 2;
  viewport.height = 422;
  viewport.offsetTop = 80;
  send("resize");
  send("scroll");
  expect(root.classList.contains("page-zoomed")).toBeTrue();
  expect(root.style.getPropertyValue("--vv-height")).toBe("844px");
  expect(root.style.getPropertyValue("--vv-top")).toBe("0px");
  expect(root.style.getPropertyValue("--kb")).toBe("0px");
  expect(scrolls).toBe(baselineScrolls);
  expect(resizes).toBe(0);

  viewport.height = 240;
  send("resize");
  expect(root.style.getPropertyValue("--vv-height")).toBe("480px");
  expect(root.style.getPropertyValue("--kb")).toBe("364px");
  expect(resizes).toBe(1);
  viewport.height = 422;
  send("resize");
  expect(resizes).toBe(2);

  viewport.scale = 1;
  viewport.height = 844;
  viewport.offsetTop = 0;
  send("resize");
  expect(root.classList.contains("page-zoomed")).toBeFalse();
  expect(resizes).toBe(2);
  happy.innerWidth = 844;
  happy.innerHeight = 390;
  viewport.height = 390;
  happy.dispatchEvent(new happy.Event("resize"));
  expect(resizes).toBe(3);
  expect(root.style.getPropertyValue("--vv-height")).toBe("390px");
});
