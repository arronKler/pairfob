import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("session lifecycle source contracts", () => {
  test("guided and chat shells read adopted owner keys instead of allocating WeakMap ids", () => {
    for (const rel of ["./guided/session-pane.tsx", "./chat/agent-chat.tsx"]) {
      const text = source(rel);
      expect(text).not.toContain("WeakMap");
      expect(text).toContain("sessionOwner().key");
    }
  });

  test("complete-terminal release does not unmount the App React root", () => {
    const text = source("./full-terminal/full-terminal-screen.tsx");
    expect(text).not.toMatch(/leaveReactScreen/);
    expect(text).toContain("setFullTerminalDocumentMode(false)");
  });

  test("complete-terminal engine reuses the session owner port", () => {
    const text = source("./full-terminal/full-terminal-engine.ts");
    expect(text).not.toContain("WeakMap");
    expect(text).toContain("bindSessionOwnerFromLive");
  });

  test("agent chat does not snapshot details DOM during render", () => {
    const text = source("./chat/agent-chat.tsx");
    expect(text).not.toContain("readDetailsState");
  });

  test("chat, guided, and desk React functions do not bind owner during render", () => {
    for (const rel of [
      "./chat/agent-chat.tsx",
      "./guided/session-pane.tsx",
      "../../app/layout/desk.tsx",
    ]) {
      expect(source(rel)).not.toContain("bindSessionOwnerFromLive");
    }
  });

  test("the frame prepares the desk session owner and scroll before App creates the session child", () => {
    // The old renderDesk painter registered the owner before createElement. In
    // the mounted App that boundary is frame preparation: the owner preparer is
    // notified and the guided scroll is captured before the prepared frame is
    // adopted and React renders, on both phone and desk.
    const prepare = source("../../app/frame-prepare.ts");
    const notify = prepare.indexOf("notifySessionOwnerPreparer(");
    expect(notify).toBeGreaterThan(-1);
    expect(notify).toBeLessThan(prepare.indexOf("adoptPreparedFrame("));
    expect(prepare).toContain("prepareSessionPaint()");
    // Preparation binds the registered session view; it never binds live
    // identity from inside a React render.
    expect(prepare).not.toContain("bindSessionOwnerFromLive");
    // The desk shell composes children App hands it; it owns no session binding.
    const desk = source("../../app/layout/desk.tsx");
    expect(desk).not.toContain("registerSessionView");
    expect(desk).not.toContain("bindSessionOwnerFromLive");
    // App's desk composition mounts the real session children declaratively.
    const app = source("../../app/App.tsx");
    const deskChild = app.slice(app.indexOf("function deskChild"));
    expect(deskChild).toContain("AgentChatPane");
    expect(deskChild).toContain("SessionPane");
    expect(deskChild).not.toContain("registerSessionView");
    expect(deskChild).not.toContain("bindSessionOwnerFromLive");
  });

  test("phone chat is declaratively composed by App and the frame registers the session view before React renders it", () => {
    // The retired renderAgentChat painter called registerSessionView() before
    // mounting AgentChatPane. In the mounted App that boundary is the frame
    // seam: bootstrap installs the real registerSessionView as the owner
    // preparer, frame preparation notifies it before adopting the frame, and
    // App composes the phone chat route declaratively from that prepared frame.
    const app = source("../../app/App.tsx");
    const chatCase = app.slice(app.indexOf('case "chat"'));
    expect(chatCase).toContain("<AgentChatPane includeBack handlers={handlers} />");
    expect(chatCase).not.toContain("registerSessionView");
    expect(chatCase).not.toContain("bindSessionOwnerFromLive");
    expect(chatCase).not.toContain("createRoot");
    // The registered owner port is wired by production bootstrap, outside React.
    const bootstrap = source("../../app/bootstrap.ts");
    expect(bootstrap).toContain("registerSessionOwnerPreparer(registerSessionView)");
    // Preparation notifies the registered view before the adopted frame is
    // published and React composes the (phone or desk) session child.
    const prepare = source("../../app/frame-prepare.ts");
    const prep = prepare.slice(prepare.indexOf("export function prepareFrame"));
    const notify = prep.indexOf("notifySessionOwnerPreparer(");
    expect(notify).toBeGreaterThan(-1);
    expect(notify).toBeLessThan(prep.indexOf("return adoptPreparedFrame("));
    // The register.ts owner binds live identity outside React; no painter
    // installs AgentChatPane into its own root any more.
    const register = source("./register.ts");
    expect(register).toContain("bindSessionOwnerFromLive()");
    expect(register).not.toContain("renderAgentChat");
    expect(register).not.toContain("renderReactScreen");
  });

  test("registerSessionView binds live identity outside React", () => {
    const register = source("./register.ts");
    expect(register).toContain("bindSessionOwnerFromLive()");
    expect(register).toContain("Never from a React render function");
  });

  test("full-terminal wins composition over desk and is declaratively composed; desk and pane stay declarative", () => {
    // Layout derivation gives a full terminal its own mode ahead of desk. The
    // mounted App composes that mode declaratively via <FullTerminalRoute/> (it
    // no longer returns null for an adopted screen); preparation runs the
    // controller's prepareFullTerminal before React renders. The desktop shell
    // and guided pane remain declarative composition.
    const layout = source("../../app/layout.ts");
    const fullTerminal = layout.indexOf('? "full-terminal"');
    const desk = layout.indexOf('? "desk"');
    expect(fullTerminal).toBeGreaterThan(-1);
    expect(desk).toBeGreaterThan(-1);
    expect(fullTerminal).toBeLessThan(desk);
    const app = source("../../app/App.tsx");
    const pageFor = app.slice(app.indexOf("export function pageFor"));
    // full-terminal is the last case; slice to the end of pageFor.
    const terminalCase = pageFor.slice(pageFor.indexOf('case "full-terminal"'));
    // Declarative route, not a null/bridge-adopted node.
    expect(terminalCase).toContain("<FullTerminalRoute");
    expect(terminalCase).not.toContain("return null");
    expect(terminalCase).not.toContain("DeskShell");
    expect(pageFor).toContain("DeskShell deskPage");
    expect(pageFor).toContain("<SessionPane includeBack");
    // Frame preparation prepares the terminal (document mode, status, view); it
    // creates no screen and the legacy renderer entry is retired.
    const prepare = source("../../app/frame-prepare.ts");
    expect(prepare).toContain("prepareFullTerminal()");
    expect(prepare).not.toContain("renderFullTerminal");
    // The route assembles the screen with stable handlers + controller ports,
    // and the engine attaches from the host layout effect (not preparation).
    const route = source("./full-terminal/full-terminal-route.tsx");
    expect(route).toContain("<FullTerminalScreen");
    expect(route).not.toContain("adoptExternalScreen");
    expect(route).not.toContain("renderReactScreen");
    const controller = source("./full-terminal/full-terminal.ts");
    expect(controller).toContain("export function prepareFullTerminal");
    expect(controller).not.toContain("export function renderFullTerminal");
  });

  test("rail and swipe underlay do not mount AgentChatPane or read sessionOwner", () => {
    // The real rail/page owner is pages/home; the underlay adapter is the real
    // mountPaneUnderlay owner in features/session/guided. Neither binds session
    // identity in render.
    for (const rel of ["../../pages/home/index.tsx", "./guided/pane-underlay.tsx"]) {
      const text = source(rel);
      expect(text).not.toContain("AgentChatPane");
      expect(text).not.toContain("sessionOwner");
      expect(text).not.toContain("bindSessionOwnerFromLive");
      expect(text).not.toContain("prepareSessionPaint");
    }
    // The moved underlay still hosts the real HomePage (the retired wrapper's
    // HomeScreen delegated to it) and stays a separate React root.
    expect(source("./guided/pane-underlay.tsx")).toContain("HomePage");
    expect(source("./guided/pane-underlay.tsx")).toContain("createRoot(element)");
    expect(source("../../pages/home/index.tsx")).toContain("export function HomeRail");
    expect(source("./guided/pane-swipe.ts")).toContain("mountPaneUnderlay");
    expect(source("./guided/pane-swipe.ts")).toContain("!isDesk()");
    // (Obsolete pure re-export check on ui/pane-swipe.ts removed: the same case
    // constrains the real features/session/guided/pane-swipe source above.)
  });
});
