/** Installed inside the untrusted document; its parent grants only bounded file reads. */
export function installPreviewFetch(base: string, token: string): void {
  // A virtual base resolves local resources, while the document itself is srcdoc.
  // Keep fragment-only routing local instead of resolving it against that base.
  for (const method of ['pushState', 'replaceState'] as const) {
    const native = history[method].bind(history);
    history[method] = (data, unused, url) => {
      const value = url == null ? url : String(url);
      return native(data, unused, typeof value === 'string' && value.startsWith('#') ? `about:srcdoc${value}` : value);
    };
  }
  document.addEventListener('click', event => {
    const anchor = (event.target as Element).closest?.('a[href^="#"]');
    if (!anchor || event.defaultPrevented) return;
    const hash = anchor.getAttribute('href')!;
    event.preventDefault();
    history.pushState(null, '', hash);
    let id = hash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* Keep a literal malformed fragment. */ }
    document.getElementById(id)?.scrollIntoView();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  const nativeFetch = window.fetch.bind(window);
  let serial = 0;
  const waiting = new Map<number, { resolve(value: Response): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'file-response' || event.data.token !== token) return;
    const item = waiting.get(event.data.id);
    if (!item) return;
    waiting.delete(event.data.id);
    clearTimeout(item.timer);
    if (event.data.error) item.reject(new Error(event.data.error));
    else item.resolve(new Response(event.data.bytes, { headers: { 'Content-Type': event.data.mime } }));
  });
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), base);
    if (url.origin !== new URL(base).origin) return nativeFetch(input, init);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return Promise.reject(new Error('Preview files are read-only'));
    if (waiting.size >= 16) return Promise.reject(new Error('Too many preview file requests'));
    const signal = init?.signal || (input instanceof Request ? input.signal : null);
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise<Response>((resolve, reject) => {
      const id = ++serial;
      const abort = () => { const item = waiting.get(id); if (!item) return; clearTimeout(item.timer); waiting.delete(id); reject(new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      const done = () => signal?.removeEventListener('abort', abort);
      waiting.set(id, {
        resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); },
        timer: setTimeout(() => { waiting.delete(id); done(); reject(new Error('Preview file request timed out')); }, 30000),
      });
      parent.postMessage({ type: 'file-read', token, id, url: url.href }, '*');
    });
  };
  const report = (message: string) => parent.postMessage({ type: 'preview-error', token, message: message.slice(0, 1000) }, '*');
  window.addEventListener('error', event => { if (event.message) report(event.message); });
  window.addEventListener('unhandledrejection', event => report(String(event.reason)));
}
