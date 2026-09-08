# PWA React migration acceptance

The 2026-09-09 deployment-readiness follow-up is recorded in
[pwa-react-release-review.md](./pwa-react-release-review.md). It adds 21 regression
tests, independently reviewed asynchronous-owner fixes, actual Worker/Herdr
pairing and PTY acceptance, and final release packing/dry-run. The figures and
asset hashes below preserve the original migration acceptance record.

The PWA now uses **Vite + React 19 + TypeScript + SCSS + Tailwind CSS 4**.
All application routes, menus, dialogs, scanner chrome and terminal controls
render through React. Protocol/controller state and the native input, gesture,
measurement and external-renderer boundaries remain separate from rendering.

## Delivered scope

- Boot/resume/pairing and manual code entry; computer picker and management.
- Mobile home, desktop rail/workspace, grouping and completion attention.
- Settings, devices, quotas, daemon-update status and worktree progress.
- Workspace directories/files, Git changes/diffs/notes, branches and file actions.
- Board workspace/tab navigation, zoom/pan and ANSI pane previews.
- Guided terminal, echo/unread/selection, row actions, composer, keypad and slash pad.
- Agent chat, streamed Markdown/details, history and prompt composition.
- Full terminal with effect-managed xterm/WebGL, keyboard/pad, resize and lifecycle.
- React portals for operation forms, confirmations, help, action sheets and scanner.

The persistent root preserves input/IME/selection across ordinary updates.
Session, pane and view-incarnation boundaries retire stale effects, held keys,
modals and asynchronous results. Mutations retain their original no-replay policy.
The frozen protocol/crypto, capability gates and daemon/Worker implementation were
not changed by this migration.

Old DOM page builders and non-React visual patch fallbacks were removed.
Remaining imperative DOM operations serve focus/selection, scroll, native events,
font/WebGL probes, sanitized Markdown parsing, external engines or decorative
motion. Independent source review found no remaining page-rendering fallback.

Styles use actual Sass modules with the original cascade preserved. Tailwind
is imported separately through its Vite plugin with a `tw` prefix and without
Preflight. Actual chrome components use its generated utilities; most detailed
visual rules remain in SCSS.

## Validation

The reference checkout is commit `224e9772553e4787bb12d8214b6e24936378445a`
at `/tmp/pairfob-react-baseline-224e977`.

- `./scripts/verify.sh` passed end to end. It covered formatting/shell/schema
  checks, Go vet/tests/race, vulnerability scan (none found), script/plugin/docs
  tests, PWA tests/types/build, asset packing, Worker tests/types and Wrangler
  runtime tests. Log: `/tmp/pairfob-react-final-verify-r2.log`.
- That run passed **1,305 PWA tests** across 190 files, **86 Worker source tests**,
  5 Worker harness tests and 5 Wrangler runtime tests. A subsequent test-only
  `act` cleanup passed independent review. The final full-PWA rerun passed all
  1,305 tests / 6,471 assertions in 54.21 s with zero React update warnings.
  Log: `/tmp/pairfob-react-final-pwa-tests.log`.
- Source and QA typechecks passed. Every handwritten PWA source/test/script is
  within the 800-line limit; `git diff --check` passed.
- Independent module and cleanup reviews found and rechecked ownership, stale
  result, focus, input, gesture and test-coverage issues. Final cleanup review
  passed 154 tests / 844 assertions. Final test-lifecycle review passed 57 tests /
  249 assertions, followed by 6 tests / 21 assertions for the last warning cleanup.
- **148 unique screenshot pairs had zero changed pixels.** Coverage includes
  mobile/desktop, 360 px, the 899/900 px breakpoint, Chinese/English, selected
  full-height settings/devices/quota pages and two real WebGL renderer captures.
- After final production-source cleanup, **36 paired captures were repeated**
  against freshly loaded reference and React documents: all 36 remained pixel
  identical. These repeat existing cases and are not added to the 148 count.
- Final browser smoke visited all 56 fixture scenes at 390x844 and 1440x900:
  **112 successful checks**, all React-owned, with no recorded runtime errors.
- Browser gestures covered guided text/Enter and focus retention, held chat send,
  settings/help focus, workspace/file/diff-note flows, board zoom/fit/pan and
  navigation, file rename/cancel-delete, and uncertain deletion without replay.
- Real xterm/WebGL browser checks covered text/Enter once, reconnect without
  mutation replay, back/bridge close, real context loss and explicit retry.
  Denied camera permission retires scanner resources and opens manual pairing.
- A real local Worker served the production `/pair` shell and `/api/config` with
  HTTP 200. The browser loaded the exact final JS/CSS, showed a React-owned
  pairing screen without notices/errors, and accepted native manual-code input.
  Artifact: `/tmp/pairfob-react-production-worker-browser.json`.

## Build and artifacts

The final browser and independent asset check observed:

- `index-Bg5DQ-ER.js`: 868,180 bytes, about 282.57 kB gzip.
- `index-bbr2CfSU.css`: 102,713 bytes, about 19.55 kB gzip.
- xterm remains a separate lazy chunk. All five used Tailwind utility selectors
  and representative SCSS rules are present in the actual built CSS.

Vite emits its existing 500 kB chunk-size advisory for the main JS bundle; the
threshold was not loosened. The build succeeds. This migration does not claim a
new bundle-size or physical-device performance target.

Reproducible fixture instructions are in `pwa/qa/README.md`; screenshot comparison
uses `pwa/scripts/compare-ui-screenshots.py`. Evidence locations:

- `/tmp/pairfob-react-visual/`: accepted captures, comparison HTML/JSON and metadata.
- `/tmp/pairfob-react-visual/final-paired/comparison/`: final 36-pair re-verification.
- `/tmp/pairfob-react-final-browser-smoke.json`: final 112-scene results.
- `/tmp/pairfob-react-browser-interaction-results.md`: browser interaction evidence.
- `/tmp/pairfob-react-final-structure-review.md`: source and compiled-asset review.
- `/tmp/pairfob-react-guided-cleanup-review.md`: final production cleanup review.
- `/tmp/pairfob-react-final-test-lifecycle-review.md`: final test adapter review.
- `/tmp/pairfob-react-final-source-hashes-after.json`: final source/test/QA hashes.

Early screenshot reruns against historical captures exposed fixture attention
history: the fixed clock retained highlight marks across reused scenes. Fresh,
paired documents eliminated those differences and small capture timing residuals
without changing product or QA source. The first full cleanup suite also caught
one test that still fabricated the old terminal DOM; it now mounts the real React
screen and checks host identity through the production status event path.

## Acceptance boundaries

Screenshots are defined state/viewport checks, not a guarantee for every possible
content/device combination. Fixture RPC calls are local stubs; WebGL is the real
browser engine. The local Worker check validates build/config delivery and first
page interaction, not a real pairing handshake or PTY session.

No deployment, daemon upgrade, physical-camera/keyboard/IME acceptance or real
phone/WAN test was performed. The migration is in the working tree and has no root
commit. The user's unrelated `design/` and deletions of the two PWA performance
documents remain untouched.
