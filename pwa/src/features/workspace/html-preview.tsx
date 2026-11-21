import { previewMedia } from './preview-media';
import { previewCache } from './preview-cache';
import { connectionStore } from '../connection/connection-store';
import { dashboardStore } from "../dashboard/catalog-store";
import "./workspace-preview.scss";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { computersStore } from '../computers/catalog-store';
import { useLiveSession } from '../computers/hooks';
import { t } from '../../lib/i18n';
import { messageOf } from '../../lib/notices';
import { ProtocolError } from '../../lib/protocol/errors';
import { notePreviewStage, usePreviewFrameWidth, usePreviewStageWidth, PREVIEW_DESKTOP_WIDTH, type PreviewControls } from './preview-controls';
import type { FoundLines } from './file-find';
import { FileSource } from './file-source';
import type { WorkspaceSnapshot } from './model';
import { activeScope, getWorkspaceSnapshot, issueTicket, subscribeWorkspace, workspaceContentVersion, workspacePaneCwd } from './store';
import { PreviewResources } from './preview-resources';
import { preparePreviewDocument } from './preview-document';
import { DesktopPreview } from './preview-desktop';

export { isHTMLFile } from "./preview-controls";
type Loaded = { token: string; source: string; html: string; resources: PreviewResources };
type PageSize = { width: number; height: number };

function PreviewFrame({ loaded, onError, onSize, hidden, width }: {
  hidden: boolean; loaded: Loaded; onError: (error: string) => void;
  onSize: (size: PageSize) => void;
  /** The width the page is tried at, in pixels; null takes the stage's own. Resizing the frame never reloads it. */
  width: number | null;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const connect = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    let channel: MessageChannel | null = null;
    let alive = true;
    let requests = 0;
    let timer: ReturnType<typeof setTimeout>;
    connect.current = () => {
      clearTimeout(timer);
      channel?.port1.close();
      channel = new MessageChannel();
      const port = channel.port1;
      timer = setTimeout(() => { if (alive) onError(t('preview.missing')); }, 30000);
      port.onmessage = async ({ data }) => {
        if (!alive) return;
        if (data?.type === 'preview-ready') { clearTimeout(timer); setReady(true); return; }
        if (data?.type === 'preview-error' && typeof data.message === 'string') { onError(data.message.slice(0, 1000)); return; }
        if (data?.type === 'preview-size' && Number.isFinite(data.width) && Number.isFinite(data.height)
          && data.width >= 0 && data.width <= 4000 && data.height >= 0 && data.height <= 20000) {
          onSize({ width: data.width, height: data.height });
          return;
        }
        if (data?.type !== 'file-read' || typeof data.url !== 'string' || data.url.length > 8192
          || !Number.isSafeInteger(data.id) || requests >= 16) return;
        requests++;
        try {
          const resource = await loaded.resources.read(data.url);
          if (alive) port.postMessage({ type: 'file-response', id: data.id, ...resource });
        } catch (error) {
          if (alive) port.postMessage({ type: 'file-response', id: data.id, error: messageOf(error) });
        } finally { requests--; }
      };
      frame.current?.contentWindow?.postMessage({ type: 'pairfob-preview', html: loaded.html, token: loaded.token }, '*', [channel.port2]);
    };
    return () => { alive = false; clearTimeout(timer); channel?.port1.close(); connect.current = () => undefined; };
  }, [loaded, onError, onSize]);
  return <iframe aria-busy={!ready} data-preview-ready={ready ? "true" : "false"} hidden={hidden} ref={frame} className="workspace-html-frame" title={t('preview.title')}
    style={width === null ? undefined : { width: `${width}px` }}
    src="/preview/runner.html" sandbox="allow-scripts allow-forms allow-downloads allow-popups"
    referrerPolicy="no-referrer" onLoad={() => connect.current()} />;
}

export function HTMLPreview({ snapshot, wrap, controls, found = null }: {
  snapshot: WorkspaceSnapshot; wrap: boolean; controls: PreviewControls;
  /** What a find in the page's source matched, marked when the source is what is shown. */
  found?: FoundLines | null;
}) {
  const file = snapshot.file!;
  const session = useLiveSession();
  const contentVersion = useSyncExternalStore(subscribeWorkspace, workspaceContentVersion);
  const { mode, started, reload } = controls;
  const network = useSyncExternalStore(connectionStore.subscribe, connectionStore.get);
  const direct = network.sessionTransport === 'p2p' && !network.transportSwitching && network.networkOnline && network.phase === 'live';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [runtimeError, setRuntimeError] = useState('');
  const [pageSize, setPageSize] = useState<PageSize | null>(null);
  const stage = useRef<HTMLElement>(null);
  const frameWidth = usePreviewFrameWidth();
  const stageWidth = usePreviewStageWidth();
  // The info bar offers the width choice by this stage's own width, not the window's.
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => notePreviewStage(node.clientWidth);
    measure();
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    sized?.observe(node);
    return () => { sized?.disconnect(); notePreviewStage(0); };
  }, []);
  // A page at a PC's width on a narrower stage is read on a zoom surface: the
  // whole page laid out as the PC lays it out, fitted to the stage and read like
  // a picture. Anywhere else the frame itself is the page.
  const desktop = frameWidth === PREVIEW_DESKTOP_WIDTH && stageWidth > 0 && stageWidth < PREVIEW_DESKTOP_WIDTH;
  const sized = frameWidth !== null && mode === 'preview';
  // A height reported by the stage's own frame says nothing about the page as a
  // PC draws it: the surface starts from a PC screen and takes the page's height
  // from the frame it lays out itself.
  useLayoutEffect(() => { setPageSize(null); }, [desktop]);
  useEffect(() => {
    setLoaded(null); setSource(null); setError(''); setRuntimeError(''); setPageSize(null);
    const ticket = issueTicket({ content: 'keep' });
    const cwd = workspacePaneCwd(snapshot.paneId);
    const runtime = session?.herdSession?.();
    let alive = true;
    if (!session || !ticket || !started || !direct) return;
    const current = () => alive && ticket.current() && ticket.sameContent()
      && session.herdSession?.() === runtime && workspacePaneCwd(snapshot.paneId) === cwd && getWorkspaceSnapshot().view === 'file';
    const resources = new PreviewResources(previewMedia(session, activeScope()?.boundRoot), snapshot.paneId, file.path, current,
      previewCache.scope(session, runtime ?? null, snapshot.descriptor!.root, snapshot.paneId));
    const retire = () => {
      if (!current()) { resources.close(); setLoaded(null); setError(t('preview.stale')); }
    };
    const stops = [subscribeWorkspace(retire), computersStore.subscribe(retire), dashboardStore.subscribe(retire)];
    void (async () => {
      try {
        const resource = await resources.read(resources.base);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes);
        if (!current()) return;
        setSource(text);
        const token = crypto.randomUUID();
        const html = await preparePreviewDocument(text, resources.base, resources.read, token);
        if (current()) setLoaded({ token, source: text, html, resources });
      } catch (error) {
        if (current()) setError(error instanceof ProtocolError && error.code === 'unknown_op'
          ? t('workspace.media.unsupportedDaemon') : error instanceof ProtocolError && error.code === 'p2p_required'
            ? t('preview.p2pRequired') : messageOf(error));
      }
    })();
    return () => { alive = false; stops.forEach(stop => stop()); resources.close(); };
  }, [session, snapshot.paneId, snapshot.descriptor?.root, file.path, file.revision, reload, started, direct, contentVersion]);
  return <section ref={stage} className={`workspace-html${sized ? ' is-sized' : ''}${desktop ? ' is-desktop' : ''}`} aria-label={t('preview.title')}>
    {loaded && started && direct && (desktop
      ? <DesktopPreview key={loaded.token} hidden={mode !== 'preview'} pageHeight={pageSize?.height ?? 0}>
        <PreviewFrame loaded={loaded} hidden={false} onError={setRuntimeError} onSize={setPageSize} width={PREVIEW_DESKTOP_WIDTH} />
      </DesktopPreview>
      : <PreviewFrame key={loaded.token} loaded={loaded} hidden={mode !== 'preview'} onError={setRuntimeError} onSize={setPageSize}
        width={sized ? frameWidth : null} />)}
    {mode === 'preview' ? <>
      {!direct ? <p className="workspace-feedback" role="status">{t('preview.p2pRequired')}</p>
        : error ? <p className="workspace-feedback workspace-error" role="alert">{error}</p>
        : loaded ? null
        : <p className="workspace-feedback" role="status">{t('preview.loading')}</p>}
      {runtimeError && <p className="workspace-feedback workspace-error" role="status">{runtimeError}</p>}
    </> : <>
      <FileSource path={file.path} content={source ?? file.content} wrap={wrap} line={snapshot.sourceLine} found={found} />
      {!source && file.truncated && <p className="workspace-limit">{t('workspace.previewTruncated')}</p>}
      {error && <p className="workspace-feedback workspace-error" role="status">{error}</p>}
    </>}
  </section>;
}
