import { Window } from "happy-dom";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";

const happy = new Window({ url: "https://pairfob.com/pair" });
const globals = globalThis as unknown as Record<string, unknown>;
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage", "sessionStorage"] as const) {
  globals[name] = (happy as unknown as Record<string, unknown>)[name];
}
globals.location = happy.location;
globals.matchMedia = happy.matchMedia.bind(happy);
globals.IS_REACT_ACT_ENVIRONMENT = true;
happy.document.body.innerHTML = '<main id="app"></main>';
const { createRoot } = await import("react-dom/client");
const { Button } = await import("./chrome");
const { useObjectPress } = await import("./object-press");
const host = happy.document.createElement("div");
happy.document.body.append(host);
const root = createRoot(host as unknown as HTMLElement);
afterEach(async () => { await act(() => root.render(null)); });

test("native menu gestures and React clicks remain distinct across repaint and unmount", async () => {
  const calls: string[] = [];
  function Card({ label }: { label: string }) {
    const press = useObjectPress(() => calls.push(`menu-${label}`));
    return <Button ref={press} onClick={() => calls.push(`click-${label}`)}>Session</Button>;
  }
  await act(() => root.render(<Card label="old" />));
  const button = host.querySelector("button")!;
  await act(() => root.render(<Card label="new" />));
  expect(host.querySelector("button")).toBe(button);
  await act(() => {
    button.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    button.click();
    button.click();
  });
  expect(calls).toEqual(["menu-new", "click-new"]);
  await act(() => root.render(null));
  host.append(button);
  button.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(calls).toEqual(["menu-new", "click-new"]);
  button.remove();
});
