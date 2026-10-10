import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { WorkspaceMediaOpen, WorkspaceMediaChunk } from '../src/lib/protocol/workspace-media';
import { MEDIA_CHUNK_BYTES, MEDIA_MAX_BYTES, MEDIA_MAX_PIXELS } from '../src/lib/protocol/workspace-media';

export const PREVIEW_FILE = 'public/report.html';
export const PREVIEW_TRACE = [
  { type: 'user' as const, text: '生成一个交互式报告' },
  { type: 'assistant' as const, text: '打开 [交互式报告](/work/pairfob/public/report.html)，也可以点击 `public/report.html`。\n\n定位 [第 4 行](/work/pairfob/public/report.html:4)。\n\n资源路径 public/app.js，外部链接 [Example](https://example.com)。' },
];
const html = `<!doctype html><html lang="zh"><head><title>Preview acceptance</title>
<link rel="stylesheet" href="./report.css"></head><body>
<h1>交互式报告</h1>
<button id="increment">计数 +1</button><output id="count">0</output>
<p id="local">Local data pending</p><p id="external">External API pending</p>
<p id="cors">CORS pending</p><p id="isolation">Isolation pending</p>
<p id="module">Module pending</p><p id="full">Full file pending</p>
<img alt="Local vector" src="./icon.svg" width="24" height="24">
<a id="download" download="review.json">下载评审</a>
<script src="./app.js"></script><script type="module" src="./module.js"></script>
${'<!-- full-file integrity padding -->'.repeat(4300)}
<script>document.querySelector('#full').textContent='Full file loaded after 128 KiB';</script>
</body></html>`;
const files: Record<string, string> = {
  [PREVIEW_FILE]: html,
  'public/report.css': '@import "./colors.css"; body { font: 16px system-ui; padding: 20px; margin: 0; } button, a { padding: 12px; display:inline-block; }',
  'public/colors.css': 'body { background: #eef6ff; color: #123; }',
  'public/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="green"/></svg>',
  'public/data.json': '{"message":"Local JSON loaded"}',
  'public/module.js': 'import { label } from "./module-label.js"; document.querySelector("#module").textContent = label;',
  'public/module-label.js': 'export const label = "ES module loaded";',
  'public/app.js': `let n=0; document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(++n);
fetch('./data.json').then(r=>r.json()).then(d=>document.querySelector('#local').textContent=d.message);
fetch('http://localhost:5173/qa/preview-api').then(r=>r.json()).then(d=>document.querySelector('#external').textContent=d.message);
fetch('http://localhost:5173/qa/preview-no-cors').then(()=>document.querySelector('#cors').textContent='Unexpected CORS success').catch(()=>document.querySelector('#cors').textContent='CORS enforced');
let checks=[]; try { top.document.body; } catch { checks.push('DOM blocked'); }
try { localStorage.getItem('pairfob-secret'); } catch { checks.push('Storage blocked'); }
document.querySelector('#isolation').textContent=checks.join(' · ');
const a=document.querySelector('#download'); a.href=URL.createObjectURL(new Blob(['{"review":true}'],{type:'application/json'}));`,
};

export function createPreviewFiles() {
  let serial = 0;
  const handles = new Map<string, Uint8Array>();
  return {
    has: (path: string) => Object.hasOwn(files, path),
    file(path: string) {
      const bytes = new TextEncoder().encode(files[path]);
      return { path, kind: 'text' as const, size: bytes.length, modified_ms: 1,
        content: new TextDecoder().decode(bytes.subarray(0, 128 * 1024)), truncated: bytes.length > 128 * 1024, revision: bytesToHex(sha256(bytes.subarray(0, 128 * 1024))) };
    },
    open(path: string): WorkspaceMediaOpen {
      const bytes = new TextEncoder().encode(files[path]);
      const handle = `mh_${(++serial).toString(16).padStart(32, '0')}`;
      handles.set(handle, bytes);
      return { handle, path, kind: 'download', mime: 'application/octet-stream', size: bytes.length,
        modified_ms: 1, sha256: bytesToHex(sha256(bytes)), expires_ms: Date.now() + 60000,
        chunk_bytes: MEDIA_CHUNK_BYTES, max_bytes: MEDIA_MAX_BYTES, max_pixels: MEDIA_MAX_PIXELS, width: 0, height: 0 };
    },
    read(handle: string, offset: number, length: number): WorkspaceMediaChunk | null {
      const file = handles.get(handle);
      if (!file) return null;
      const bytes = file.slice(offset, offset + length);
      return { handle, offset, length: bytes.length, bytes, eof: offset + bytes.length >= file.length };
    },
    close(handle: string) { handles.delete(handle); },
  };
}
