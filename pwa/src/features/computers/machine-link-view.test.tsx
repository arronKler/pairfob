import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { lang, setLang } from "../../lib/i18n";
import type { MachineSummary } from "../../lib/protocol/machine-link";
import type { MachineLinks, MachineLinksView } from "./machine-link";
import { MachineLinkSection } from "./machine-link-view";

function links(view: Partial<MachineLinksView>): MachineLinks {
  const full: MachineLinksView = { machines: [], busy: null, failure: null, ...view };
  return {
    view: () => full, subscribe: () => () => undefined, refresh: async () => undefined,
    link: async () => undefined, cancel: () => undefined, dismissFailure: () => undefined,
  };
}

const machines: MachineSummary[] = [
  { id: "m1", label: "Build machine", state: "available", daemonId: "d_84e96fc860788018e276" },
  { id: "m2", label: "Staging", state: "available" },
  { id: "m3", label: "Old box", state: "disabled" },
  { id: "m4", label: "Agents", state: "session_unsupported" },
];

function render(view: Partial<MachineLinksView>, paired = new Map<string, string>(), enabled = true): string {
  return renderToStaticMarkup(
    <MachineLinkSection links={links(view)} enabled={enabled} hostId="d_host" hostTitle="Macmini" pairedTitles={paired} />,
  );
}

describe("machine link section", () => {
  const before = lang();
  beforeAll(() => { setLang("en"); });
  afterAll(() => { setLang(before); });

  test("renders nothing without the capability or without machines", () => {
    expect(render({ machines }, new Map(), false)).toBe("");
    expect(render({ machines: [] })).toBe("");
  });

  test("offers only machines that can be added and tags the ones already paired", () => {
    const html = render({ machines }, new Map([["d_84e96fc860788018e276", "workbox.local"]]));
    expect(html).toContain("Machines Macmini reaches");
    expect(html.match(/machine-add/g)).toHaveLength(1);
    expect(html).toContain("Listed above as workbox.local");
    expect(html).toContain("Disabled in Herdr");
    expect(html).toContain("Uses a named Herdr session");
  });

  test("a busy row shows its step with Cancel and holds the other rows", () => {
    const html = render({ machines, busy: { machineId: "m2", step: "installing" } });
    expect(html).toContain("Installing Pairfob…");
    expect(html).toContain("machine-cancel");
    expect(html.match(/disabled="" class="set-action machine-add"/g)).toHaveLength(1);
    expect(html.match(/machine-add/g)).toHaveLength(1);
  });

  test("a failure explains itself on its own row", () => {
    const html = render({ machines, failure: { machineId: "m2", code: "unreachable" } });
    expect(html).toContain("could not reach this machine over SSH");
    expect(html).toContain("is-error");
  });
});
