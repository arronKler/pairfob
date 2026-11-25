import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import { happy, resetBoardTestDOM } from '../../../test-support/dom';
import { expectSameNode } from '../../../test-support/node-identity';
import { renderReact, unmountReact } from '../../../test-support/react-harness';
import { attachLiveSession } from '../computers/catalog-store';
import { connectionStore, setPhase, setSessionTransport, setNetworkOnline, setTransportSwitching } from '../connection/connection-store';
import { WorkspaceReadCache } from '../../lib/workspace-cache';
import type { LiveSession } from '../../lib/protocol/session-types';
import { HTMLPreview } from './html-preview';
import { PREVIEW_DESKTOP_WIDTH, PREVIEW_WIDTH_STAGE_MIN, PreviewSwitch, previewWidthChoices, previewWidthOffered, usePreviewControls } from './preview-controls';
import { previewWidth, setPreviewWidth } from './prefs';
import { setLang } from '../../lib/i18n';
import { loadWorkspaceFile } from './actions';
import * as store from './store';

const revision = 'a'.repeat(64);
const emptySHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
let opens = 0;
let previousNetwork: ReturnType<typeof connectionStore.get>;

function View() {
  const snapshot = useSyncExternalStore(store.subscribeWorkspace, store.getWorkspaceSnapshot);
  const controls = usePreviewControls(snapshot);
  return <HTMLPreview snapshot={snapshot} wrap={false} controls={controls} />;
}

/** The info bar's switch over the stage, as the file view arranges them. */
function Page() {
  const snapshot = useSyncExternalStore(store.subscribeWorkspace, store.getWorkspaceSnapshot);
  const controls = usePreviewControls(snapshot);
  return <><div className="workspace-detail-head"><PreviewSwitch controls={controls} /></div>
    <HTMLPreview snapshot={snapshot} wrap={false} controls={controls} /></>;
}

const realMatchMedia = window.matchMedia;
const clientWidth = Object.getOwnPropertyDescriptor(happy.HTMLElement.prototype, 'clientWidth');

/** How the page is operated, and how wide its preview stage is: Happy DOM answers neither. */
function surface(fine: boolean, stage: number): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('pointer: fine') ? fine : false,
    media: query, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(happy.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) { return this.classList.contains('workspace-html') ? stage : 0; },
  });
}

const widthSwitch = () => document.querySelector<HTMLElement>('.workspace-preview-width');
const widthButtons = () => [...widthSwitch()!.querySelectorAll('button')];

beforeEach(async () => {
  await resetBoardTestDOM();
  previousNetwork = connectionStore.get();
  setPhase('live'); setNetworkOnline(true); setTransportSwitching(false); setSessionTransport('p2p');
  opens = 0;
  const api = {
    workspaceOpen: async () => ({ name: 'work', root: '/work', git: null,
      features: { files: true, git_status: false, git_diff: false, git_branches: false } }),
    workspaceRead: async (_pane: string, path: string) => ({ path, kind: 'text' as const, size: 0,
      modified_ms: 1, content: '', revision, truncated: false }),
    workspaceMediaOpen: async (_pane: string, path: string) => {
      opens++;
      return { handle: 'media_' + 'a'.repeat(32), path, kind: 'download' as const, mime: 'text/html', size: 0,
        modified_ms: 1, sha256: emptySHA, chunk_bytes: 65536, max_bytes: 33554432, max_pixels: 0,
        width: 0, height: 0, expires_ms: Date.now() + 60000 };
    },
    workspaceMediaRead: async () => { throw new Error('empty files need no chunks'); },
    workspaceMediaClose: async () => undefined,
  };
  const live = api as unknown as LiveSession;
  attachLiveSession(live);
  const { ticket } = store.beginEnter(live, 'pane', 'agent');
  const scope = await new WorkspaceReadCache(api as never, () => '/work').open('pane');
  store.bindScope(ticket, scope);
  ticket.commit({ descriptor: scope.descriptor, view: 'file', detailPath: 'report.html',
    file: await api.workspaceRead('pane', 'report.html') });
  ticket.finishLoad();
});

afterEach(async () => {
  unmountReact(); store.beginLeave(); attachLiveSession(null);
  window.matchMedia = realMatchMedia;
  if (clientWidth) Object.defineProperty(happy.HTMLElement.prototype, 'clientWidth', clientWidth);
  setPhase(previousNetwork.phase); setSessionTransport(previousNetwork.sessionTransport);
  setNetworkOnline(previousNetwork.networkOnline); setTransportSwitching(previousNetwork.transportSwitching);
  await happy.happyDOM.abort();
});

async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }

test('reopening identical content replaces its preview ticket without a false stale error', async () => {
  renderReact(<View />); await settle();
  expect(opens).toBe(1);
  expect(document.querySelector('iframe')).not.toBeNull();
  await act(async () => { await loadWorkspaceFile('report.html'); });
  await settle();
  expect(opens).toBeGreaterThan(1);
  expect(document.querySelector('iframe')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('relay blocks HTML media, P2P recovery starts it, and fallback removes the frame', async () => {
  setSessionTransport('relay'); renderReact(<View />); await settle();
  expect(opens).toBe(0);
  expect(document.querySelector('iframe')).toBeNull();
  await act(async () => { setSessionTransport('p2p'); }); await settle();
  expect(opens).toBe(1);
  expect(document.querySelector('iframe')).not.toBeNull();
  await act(async () => { setSessionTransport('relay'); }); await settle();
  expect(document.querySelector('iframe')).toBeNull();
  expect(opens).toBe(1);
});

test('a width is a question once the stage is measured: device widths where they fit, the PC width everywhere', () => {
  expect(previewWidthChoices(PREVIEW_WIDTH_STAGE_MIN)).toEqual([375, 768, PREVIEW_DESKTOP_WIDTH, 'auto']);
  expect(previewWidthChoices(PREVIEW_WIDTH_STAGE_MIN - 1)).toEqual(['auto', PREVIEW_DESKTOP_WIDTH]);
  // The column beside a session still draws its page as a PC does.
  expect(previewWidthOffered(720)).toBeTrue();
  // Nothing is measured until a preview is on the page.
  expect(previewWidthOffered(0)).toBeFalse();
});

test('a wide tablet under a finger is offered the widths too', async () => {
  setLang('en'); surface(false, 1010);
  renderReact(<Page />); await settle();
  expect(widthButtons().map((item) => item.textContent)).toEqual(['375', '768', 'PC', 'Auto']);
  act(() => { widthButtons()[0].click(); });
  expect(document.querySelector('iframe')!.style.width).toBe('375px');
});

test('375, 768 and auto hold the frame to a width and centre it, without reloading the page', async () => {
  setLang('en'); surface(true, 1000);
  renderReact(<Page />); await settle();
  expect(widthButtons().map((item) => item.textContent)).toEqual(['375', '768', 'PC', 'Auto']);
  expect(widthSwitch()!.getAttribute('aria-label')).toBe('Preview width');
  expect(widthButtons().map((item) => item.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true']);
  expect(widthButtons()[0].getAttribute('aria-label')).toBe('375 pixels wide');
  expect(widthButtons()[2].getAttribute('aria-label')).toBe('1280 pixels wide');
  const frame = document.querySelector('iframe')!;
  expect(frame.style.width).toBe('');
  expect(document.querySelector('.workspace-html')!.classList.contains('is-sized')).toBeFalse();
  act(() => { widthButtons()[0].click(); });
  expect(previewWidth()).toBe(375);
  expect(localStorage.getItem('pairfob.workspace.previewWidth')).toBe('375');
  expectSameNode(document.querySelector('iframe'), frame);
  expect(frame.style.width).toBe('375px');
  expect(document.querySelector('.workspace-html')!.classList.contains('is-sized')).toBeTrue();
  expect(opens).toBe(1);
  act(() => { widthButtons()[1].click(); });
  expect(frame.style.width).toBe('768px');
  act(() => { widthButtons()[3].click(); });
  expect(frame.style.width).toBe('');
  expect(localStorage.getItem('pairfob.workspace.previewWidth')).toBeNull();
  // The frame's sandbox is what it was: the width is the only thing the switch touches.
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-downloads allow-popups');
});

test('a PC width narrower than the stage is a boxed page, and a wider one is read on the zoom surface', async () => {
  setLang('en'); surface(true, 1000);
  renderReact(<Page />); await settle();
  act(() => { widthButtons()[2].click(); });
  const frame = document.querySelector('iframe')!;
  expect(frame.style.width).toBe('1280px');
  expect(document.querySelector('.workspace-html')!.classList.contains('is-desktop')).toBeTrue();
  expect(document.querySelector('.workspace-html-desktop')).not.toBeNull();
  expect(document.querySelector('.workspace-html-desktop-page')!.getAttribute('style')).toContain('width: 1280px');
  expect(document.querySelector('.workspace-html-desktop-tools')!.getAttribute('role')).toBe('toolbar');
  expect(frame.closest('.workspace-html-desktop-page')).not.toBeNull();
  // A wide stage holds the whole page itself: no zoom surface, a boxed page.
  unmountReact();
  surface(true, 1400);
  renderReact(<Page />); await settle();
  act(() => { widthButtons()[2].click(); });
  expect(document.querySelector('.workspace-html-desktop')).toBeNull();
  expect(document.querySelector('.workspace-html')!.classList.contains('is-desktop')).toBeFalse();
  expect(document.querySelector('iframe')!.style.width).toBe('1280px');
});

test('the source has no width to choose, and the choice waits for the preview', async () => {
  surface(true, 1000); setPreviewWidth(768);
  renderReact(<Page />); await settle();
  const source = [...document.querySelectorAll<HTMLButtonElement>('.workspace-preview-switch button')][1];
  act(() => { source.click(); });
  expect(widthSwitch()).toBeNull();
  expect(document.querySelector('.workspace-html')!.classList.contains('is-sized')).toBeFalse();
  const preview = [...document.querySelectorAll<HTMLButtonElement>('.workspace-preview-switch button')][0];
  act(() => { preview.click(); });
  expect(widthButtons()[1].getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('iframe')!.style.width).toBe('768px');
});

test('a narrow stage offers Auto and PC, and one toggle where even those two will not fit', async () => {
  for (const [fine, lang] of [[true, 'en'], [false, 'zh']] as const) {
    setLang(lang); surface(fine, 390); setPreviewWidth(375);
    renderReact(<Page />); await settle();
    expect(widthButtons().map((item) => item.textContent))
      .toEqual(lang === 'en' ? ['Auto', 'PC'] : ['自适应', '电脑']);
    expect(widthButtons()[1].getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('iframe')!.style.width).toBe('');
    expect(document.querySelector('.workspace-html')!.classList.contains('is-sized')).toBeFalse();
    act(() => { widthButtons()[1].click(); });
    expect(previewWidth()).toBe(PREVIEW_DESKTOP_WIDTH);
    expect(document.querySelector('.workspace-html-desktop')).not.toBeNull();
    act(() => { widthButtons()[0].click(); });
    expect(previewWidth()).toBe('auto');
    unmountReact();
    // Back to the remembered device width, for the other surface and the toggle below.
    setPreviewWidth(375);
  }
  // A 320-wide phone cannot hold two segments beside the bar's other controls.
  setLang('zh'); surface(false, 320);
  renderReact(<Page />); await settle();
  expect(widthSwitch()).toBeNull();
  const pc = document.querySelector<HTMLButtonElement>('.workspace-preview-pc')!;
  expect(pc.textContent).toBe('电脑');
  expect(pc.getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('iframe')!.style.width).toBe('');
  act(() => { pc.click(); });
  expect(previewWidth()).toBe(PREVIEW_DESKTOP_WIDTH);
  expect(document.querySelector('.workspace-html-desktop')).not.toBeNull();
  act(() => { document.querySelector<HTMLButtonElement>('.workspace-preview-pc')!.click(); });
  expect(previewWidth()).toBe('auto');
});
