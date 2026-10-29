import { describe, expect, test } from "bun:test";
import { AGENT_ICONS, agentIcon } from "./agent-icons";

describe("agent marks", () => {
  test("advertised kinds and their common aliases resolve to one mark", () => {
    expect(agentIcon("claude")).toBe(AGENT_ICONS.claude);
    expect(agentIcon("Claude-Code")).toBe(AGENT_ICONS.claude);
    expect(agentIcon("codex")).toBe(AGENT_ICONS.codex);
    expect(agentIcon("cursor-agent")).toBe(AGENT_ICONS.cursor);
    expect(agentIcon("qwen-code")).toBe(AGENT_ICONS.qwen);
    expect(agentIcon(" gemini ")).toBe(AGENT_ICONS.gemini);
    expect(agentIcon("pi")).toBe(AGENT_ICONS.pi);
    expect(agentIcon("agy")).toBe(AGENT_ICONS.antigravity);
    expect(agentIcon("roo-code")).toBe(AGENT_ICONS.roocode);
    expect(agentIcon("kilo")).toBe(AGENT_ICONS.kilocode);
    expect(agentIcon("qodercli")).toBe(AGENT_ICONS.qoder);
    expect(agentIcon("droid")).toBe(AGENT_ICONS.droid);
    expect(agentIcon("hermes")).toBe(AGENT_ICONS.hermes);
    expect(agentIcon("maki")).toBe(AGENT_ICONS.maki);
    expect(agentIcon("deepseek")).toBe(AGENT_ICONS.deepseek);
    expect(agentIcon("command-code")).toBe(AGENT_ICONS["command-code"]);
    expect(agentIcon("CommandCode")).toBe(AGENT_ICONS["command-code"]);
    expect(agentIcon("opencode-go")).toBe(AGENT_ICONS.opencode);
    for (const kind of ["letta", "Letta-Code", " letta-cli "]) expect(agentIcon(kind)).toBe(AGENT_ICONS.letta);
    for (const kind of ["muse", "Muse-Code", " muse-cli "]) expect(agentIcon(kind)).toBe(AGENT_ICONS.muse);
  });

  test("an unknown kind or a plain terminal has no mark, so a monogram stands in", () => {
    expect(agentIcon("aider")).toBeNull();
    expect(agentIcon("")).toBeNull();
  });

  test("bundled marks are inert path markup: no ids, scripts, links or external references", () => {
    for (const [kind, spec] of Object.entries(AGENT_ICONS)) {
      if (spec.picture !== undefined) continue;
      expect(spec.body, kind).not.toMatch(/<script|\son\w+=|\sid=|href|url\(|<image|<foreignObject/i);
      expect(spec.body, kind).toMatch(/^<(path|g)[\s>]/);
    }
  });

  test("picture marks are bundled with the app, never fetched from another host", () => {
    const pictures = Object.entries(AGENT_ICONS).filter(([, spec]) => spec.picture !== undefined);
    expect(pictures.map(([kind]) => kind)).toEqual(["muse", "maki"]);
    for (const [kind, spec] of pictures) {
      expect(spec.picture, kind).not.toMatch(/^(https?:)?\/\//i);
      expect(spec.picture, kind).toMatch(/^data:image\/(?:png|svg\+xml)[;,]|agent-marks\/(?:maki\.png|meta\.svg)$/);
    }
  });
});
