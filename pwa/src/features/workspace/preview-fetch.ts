/**
 * Installed inside the untrusted document; its parent grants only bounded file
 * reads. Serialized into the page with toString(), so it must not reach for
 * anything outside its own body.
 *
 * Static references were packed before the page ran. This covers what a page
 * asks for while it runs: fetch() and XMLHttpRequest GETs, resource URLs set on
 * elements (by property, setAttribute or inserted markup), stylesheets it adds,
 * local pages framed inside it, and links to other workspace files.
 */
export function installPreviewFetch(base: string, token: string): void {
  type Reply = { bytes: Uint8Array<ArrayBuffer>; mime: string };
  type Waiting = { settle(error: Error | null, value?: Reply): void; timer: ReturnType<typeof setTimeout> };
  const origin = new URL(base).origin;
  const here = base.split('#')[0];
  /** A URL inside the workspace, or null for external, data, blob and fragment references. */
  const local = (value: unknown): string | null => {
    if (value == null) return null;
    const text = String(value);
    if (!text || text.startsWith('#')) return null;
    try { const url = new URL(text, base); return url.origin === origin ? url.href : null; } catch { return null; }
  };

  // A virtual base resolves local resources, while the document itself is srcdoc.
  // Keep fragment-only routing local instead of resolving it against that base.
  for (const method of ['pushState', 'replaceState'] as const) {
    const native = history[method].bind(history);
    history[method] = (data, unused, url) => {
      const value = url == null ? url : String(url);
      return native(data, unused, typeof value === 'string' && value.startsWith('#') ? `about:srcdoc${value}` : value);
    };
  }

  // File reads go to the parent, at most 16 outstanding; the rest wait their turn.
  let serial = 0;
  let active = 0;
  const backlog: Array<() => void> = [];
  const waiting = new Map<number, Waiting>();
  const pump = () => { while (active < 16 && backlog.length) backlog.shift()!(); };
  const readFile = (url: string, kind?: string, signal?: AbortSignal | null) => new Promise<Reply>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    let id = 0;
    const settle = (error: Error | null, value?: Reply) => {
      if (id < 0) return;
      if (id > 0) { clearTimeout(waiting.get(id)?.timer); waiting.delete(id); active--; }
      else { const at = backlog.indexOf(start); if (at >= 0) backlog.splice(at, 1); }
      id = -1;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
      pump();
    };
    const abort = () => settle(new DOMException('Aborted', 'AbortError'));
    const start = () => {
      active++;
      id = ++serial;
      waiting.set(id, { settle, timer: setTimeout(() => settle(new Error('Preview file request timed out')), 30000) });
      parent.postMessage({ type: 'file-read', token, id, url, kind }, '*');
    };
    signal?.addEventListener('abort', abort, { once: true });
    backlog.push(start);
    pump();
  });
  const isChild = (source: unknown) => {
    for (let i = 0; i < frames.length; i++) if (frames[i] === source) return true;
    return false;
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.token !== token) return;
    if (event.source === parent) {
      if (data.type === 'file-response') waiting.get(data.id)?.settle(data.error ? new Error(data.error) : null, data);
      return;
    }
    // A local page framed inside this one reaches its files, and its links, through here.
    if (!isChild(event.source)) return;
    const child = event.source as Window;
    if (data.type === 'file-read' && typeof data.url === 'string' && Number.isSafeInteger(data.id)) {
      readFile(data.url, data.kind === 'style' ? 'style' : undefined).then(
        value => child.postMessage({ type: 'file-response', token, id: data.id, bytes: value.bytes, mime: value.mime }, '*'),
        error => child.postMessage({ type: 'file-response', token, id: data.id, error: String(error?.message || error) }, '*'));
    } else if (data.type === 'open-file' || data.type === 'preview-error') parent.postMessage(data, '*');
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = local(input instanceof Request ? input.url : String(input));
    if (!url) return nativeFetch(input, init);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return Promise.reject(new Error('Preview files are read-only'));
    const signal = init?.signal || (input instanceof Request ? input.signal : null);
    return readFile(url, undefined, signal).then(value => new Response(value.bytes, { headers: { 'Content-Type': value.mime } }));
  };

  // Element and XHR loads take a blob URL of the file, one per file and kind.
  const blobs = new Map<string, Promise<string>>();
  const blobFor = (url: string, kind?: string) => {
    const key = `${kind || 'file'} ${url.split('#')[0]}`;
    let hit = blobs.get(key);
    if (!hit) {
      hit = readFile(url, kind).then(value => URL.createObjectURL(new Blob([value.bytes], { type: value.mime })));
      hit.catch(() => undefined);
      blobs.set(key, hit);
    }
    return hit.then(href => href + new URL(url).hash);
  };

  /** Whether an element loads from this attribute, and as what: a stylesheet is packed like a static one. */
  const loads = (el: Element, attr: string, url: string): 'file' | 'style' | null => {
    const tag = el.localName;
    if (attr === 'src') {
      // A module from a blob URL could not resolve its own imports; leave it to fail plainly.
      if (tag === 'script') return el.getAttribute('type') === 'module' ? null : 'file';
      return /^(img|video|audio|source|track|embed|input)$/.test(tag) ? 'file' : null;
    }
    if (attr === 'href' && tag === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (/\bstylesheet\b/.test(rel)) return 'style';
      if (/\bicon\b/.test(rel)) return 'file';
      // A rel still to come: a .css file is a stylesheet in the making.
      return !rel && /\.css$/i.test(new URL(url).pathname) ? 'style' : null;
    }
    if (attr === 'poster') return tag === 'video' ? 'file' : null;
    if (attr === 'data') return tag === 'object' ? 'file' : null;
    return null;
  };
  const WATCHED = ['src', 'href', 'poster', 'data'];
  const wanted = new WeakMap<Element, Record<string, string>>();
  const forget = (el: Element, attr: string) => { const marks = wanted.get(el); if (marks) delete marks[attr]; };
  /** Point the element at the file once read; a later assignment wins over an earlier one still reading. */
  const swap = (el: Element, attr: string, url: string, kind: 'file' | 'style', apply: (value: string) => void, onFailure: boolean) => {
    const marks = wanted.get(el) || {};
    wanted.set(el, marks);
    marks[attr] = url;
    blobFor(url, kind === 'style' ? 'style' : undefined).then(
      href => { if (marks[attr] === url) apply(href); },
      // A direct assignment still lands, so the element reports its own error as a missing file would.
      () => { if (onFailure && marks[attr] === url) apply(url); });
  };
  const props: Array<[string, string]> = [
    ['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLLinkElement', 'href'], ['HTMLMediaElement', 'src'],
    ['HTMLSourceElement', 'src'], ['HTMLTrackElement', 'src'], ['HTMLEmbedElement', 'src'], ['HTMLInputElement', 'src'],
    ['HTMLVideoElement', 'poster'], ['HTMLObjectElement', 'data'],
  ];
  const globals = window as unknown as Record<string, { prototype: object } | undefined>;
  for (const [name, attr] of props) {
    const proto = globals[name]?.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, attr);
    const set = desc?.set;
    if (!proto || !desc || !set) continue;
    Object.defineProperty(proto, attr, {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set(this: Element, value: unknown) {
        const url = local(value);
        const kind = url && loads(this, attr, url);
        if (!url || !kind) { forget(this, attr); set.call(this, value); return; }
        swap(this, attr, url, kind, href => set.call(this, href), true);
      },
    });
  }
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    const attr = String(name).toLowerCase();
    if (!WATCHED.includes(attr)) return nativeSetAttribute.call(this, name, value);
    const url = local(value);
    const kind = url && loads(this, attr, url);
    if (!url || !kind) { forget(this, attr); return nativeSetAttribute.call(this, name, value); }
    swap(this, attr, url, kind, href => nativeSetAttribute.call(this, name, href), true);
  };
  // Markup inserted as text never passes a setter: adopt its references as they arrive.
  const adopt = (el: Element) => {
    for (const attr of WATCHED) {
      const url = local(el.getAttribute(attr));
      const kind = url && loads(el, attr, url);
      if (url && kind && wanted.get(el)?.[attr] !== url) swap(el, attr, url, kind, href => nativeSetAttribute.call(el, attr, href), false);
    }
  };
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        // An inserted <script> runs only through the setters above; markup never runs one.
        if (el.localName !== 'script') adopt(el);
        el.querySelectorAll('img,video,audio,source,track,embed,input,link,object').forEach(adopt);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    type Plan = { method: string; url: string; headers: Array<[string, string]>; cancelled?: boolean };
    const { open, send, setRequestHeader, abort } = XHR.prototype;
    const plans = new WeakMap<XMLHttpRequest, Plan>();
    XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const target = local(url);
      plans.delete(this);
      // A synchronous request cannot wait for the parent; it fails as it would without this bridge.
      if (target && rest[0] !== false && String(method).toUpperCase() === 'GET') { plans.set(this, { method, url: target, headers: [] }); return; }
      return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XHR.prototype.open;
    XHR.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      const plan = plans.get(this);
      if (plan) plan.headers.push([name, value]); else setRequestHeader.call(this, name, value);
    };
    XHR.prototype.abort = function (this: XMLHttpRequest) {
      const plan = plans.get(this);
      if (plan) plan.cancelled = true;
      abort.call(this);
    };
    XHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const plan = plans.get(this);
      if (!plan) return send.call(this, body);
      const go = (href: string) => {
        if (plan.cancelled || plans.get(this) !== plan) return;
        open.call(this, plan.method, href, true);
        for (const [name, value] of plan.headers) setRequestHeader.call(this, name, value);
        send.call(this);
      };
      blobFor(plan.url).then(go, () => go(plan.url));
    };
  }

  // Fragment links scroll here; links to other workspace files open them in Pairfob.
  // Listened for on the window, after the page's own handlers had their say.
  window.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || anchor.hasAttribute('download')) return;
    const href = anchor.getAttribute('href')!;
    const url = local(href);
    const hash = href.startsWith('#') ? href : url && url.includes('#') && url.split('#')[0] === here ? url.slice(url.indexOf('#')) : null;
    if (hash) {
      event.preventDefault();
      history.pushState(null, '', hash);
      let id = hash.slice(1);
      try { id = decodeURIComponent(id); } catch { /* Keep a literal malformed fragment. */ }
      document.getElementById(id)?.scrollIntoView();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    if (!url) return;
    event.preventDefault();
    parent.postMessage({ type: 'open-file', token, url, rooted: href.startsWith('/') && !href.startsWith('//') }, '*');
  });

  const report = (message: string) => parent.postMessage({ type: 'preview-error', token, message: message.slice(0, 1000) }, '*');
  window.addEventListener('error', event => { if (event.message) report(event.message); });
  window.addEventListener('unhandledrejection', event => report(String(event.reason)));
  // The host reads the page at a chosen width, and on a narrow screen it draws
  // the whole document on a zoom surface: the document's own size is measured
  // here, where only the document can see it. Bounded and debounced, because a
  // page that lays itself out against its viewport reflows as its frame grows.
  let sizeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSize = '';
  const postSize = () => {
    const root = document.documentElement;
    if (!root) return;
    const width = Math.round(root.scrollWidth);
    const height = Math.min(16000, Math.round(root.scrollHeight));
    const key = `${width}x${height}`;
    if (key === lastSize) return;
    lastSize = key;
    parent.postMessage({ type: 'preview-size', token, width, height }, '*');
  };
  const scheduleSize = () => { clearTimeout(sizeTimer); sizeTimer = setTimeout(postSize, 120); };
  window.addEventListener('load', scheduleSize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleSize).observe(document.documentElement);
  if (document.fonts) void document.fonts.ready.then(scheduleSize, () => undefined);
  scheduleSize();
}
