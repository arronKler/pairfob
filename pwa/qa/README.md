# Deterministic PWA parity fixtures

This directory is a Vite development HTML entry. It is not referenced by `pwa/index.html` or the production build. It imports screen/controllers directly, never `src/main.ts`; session calls are local stubs and all unmocked application fetch/WebSocket calls are blocked. No production RPC or stored credential is used.

Use a dedicated browser context and the same browser version, installed fonts, timezone (`UTC` recommended), language and viewport for both trees. Copy this entire `qa/` directory into an immutable baseline checkout before starting its existing Vite server. The baseline checkout requires only its existing dependencies. Its `mode=baseline` branch never imports the React adapter. The default mode is React; baseline URLs must explicitly opt in.

`baseline.ts` is a reference-checkout adapter for commit `224e9772553e4787bb12d8214b6e24936378445a`. Its imports intentionally target retired UI APIs from that checkout. Both adapters are dynamically isolated; current `tsconfig.qa.json` excludes only this reference file. Validate the current adapter with `bun run typecheck:qa`; after copying `qa/` into the baseline, validate that adapter there with `bunx tsc --noEmit -p qa/tsconfig.baseline.json`. The shared `shell.ts` contains the document class contract used by both terminal fixtures.

URLs (replace server port as needed):

- `/qa/index.html?mode=baseline&scene=home-populated&lang=zh`
- `/qa/index.html?mode=react&scene=connect-manual&lang=en`
- `/qa/index.html?mode=react&scene=guided-ime&lang=zh`

Baseline styles default to `/src/style.css`; React styles default to `/src/style.scss`. During staged migration use `&style=/src/style.css` if the SCSS entry has not landed. The `style` override accepts only a local source CSS/SCSS path. `mode=baseline` refers to the modules in the serving checkout: the original immutable checkout is required for a genuine old-version comparison.

Wait for `window.qa` and then `await window.qa.ready`, or wait for `html[data-qa-ready="true"]`. No fixture toolbar is rendered. Example browser evaluation:

```js
await window.qa.ready;
window.qa.scenes; // Names and descriptions for every supported state.
await window.qa.setScene("workspace-diff");
window.qa.snapshot();
```

`setScene` serializes changes and resets prior session ownership, compose drafts, trace caches, board previews, pending workspace requests, DOM, dialogs and call logs. It waits for pending-skeleton reveal when relevant, fonts and animation frames. `setLanguage("en")` resets the current fixture scene in the requested locale. Viewport comes entirely from the browser; `desktop-*` names do not force width. Resize through the browser to exercise the real 900 px breakpoint.

The snapshot includes:

- Actual root React ownership and count of React-managed DOM elements, detected from runtime DOM instrumentation. `mode=react` with `reactOwned=false` means the production router still used a legacy fallback. A green screenshot alone does not prove migration.
- App/body/root classes, phase/screen, viewport and timezone, and document/app horizontal overflow.
- Rectangles for core shells, scrollports, panes, compose pads and dialogs.
- Stable input node IDs, values, focus, and selection. Compare IDs before/after interactions in the same scene to detect remounts; IDs across page loads are unrelated.
- All read, mutation, lifecycle and attempted network calls, plus runtime error/unhandled-rejection messages.

Interaction controls:

```js
window.qa.clearCalls();
window.qa.hold("promptAgent");
// Drive the actual visible send button using the browser.
window.qa.calls; // Exactly the calls made by the UI.
window.qa.release("promptAgent");
window.qa.failNext("workspaceDelete", "unknown_outcome");
window.qa.setConnected(false); // Fixture connection and network flags; no real transport.
await window.qa.render();
```

For the renderer fixture, select `terminal-live`, wait for a recorded `terminalOpen` and a hidden `.full-terminal-state`, then send a local frame with `window.qa.terminalFrame("\u001b[2J\u001b[Hpairfob renderer QA\r\n")`. The helper returns false if no local terminal is open; options accept `full`, `sequence`, `cols` and `rows` for stale/gap/resize probes. Terminal IDs change on each local open. `terminal-open-error` rejects the first local open, allowing retry with the real renderer. Both use the real xterm/WebGL modules and production terminal event/visibility handlers; the session RPC and frame source remain local stubs. No socket or PTY is involved.

`emit(event)` only emits to subscribers on the fixture session; it does not simulate the production socket handshake. Fixture results are deterministic and reflect return shapes at the session API boundary. They are not a second implementation of the daemon. Some mutations update local snapshot data (rename/close); create/workspace mutation responses are logged canned results, so this is a UI call-count and ownership harness rather than backend semantics validation.

Available scene families: boot/resuming; initial/manual/failed/add-computer pairing and computer approval; one/many computers; empty/populated/grouped/offline home; responsive desktop empty/guided/chat; settings online/offline/devices/loading/error; quotas populated/loading/error; empty/populated board; workspace loading/root/nested/file/file-loading/changes/diff/diff-loading/error; guided draft/IME/expanded/slash/wrap/selection/row actions; agent chat streaming/complete/draft/empty/loading/error/older; terminal loading/error shell.

Important gaps and limits:

- `terminal-loading` and `terminal-error` are marked `shellOnly=true`: the baseline uses its original shell builders, and the React adapter mounts the production FullTerminalScreen with an inactive engine. They verify shell/control React ownership and visual parity, but intentionally do not start xterm or TerminalOpen. WebGL/frame behavior and terminal bridge lifecycle require separate scenarios.
- Camera is deterministically denied, clipboard is local, Notification permission requests return denied, credential IndexedDB is blocked, and no real push subscription/handshake/pairing is performed. Add separately authorized live/device checks for these paths.
- Seeded scenes cover page states, not every modal or control combination. Open existing menus, operation forms, diff-note editors, help dialogs and file confirmations via browser interactions on these scenes. Dedicated declarative modal scenes, update-in-progress fixtures, live viewport keyboard simulation, long trace stress tests and full native-device IME/pinch/foreground checks remain to add.
- Date/Date.now are fixed at `2026-09-08T04:00:00.000Z`; monotonic gesture/timer clocks remain real. Animations/transitions and caret paint are disabled without changing the browser motion preference or layout rules. This is static geometry/color parity, not animation acceptance.
- When recording acceptance evidence, keep source/test, rendered fixture, live transport and physical-device results distinct.
