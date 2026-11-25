import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { WorkspaceMediaOpen, WorkspaceMediaChunk } from '../src/lib/protocol/workspace-media';
import { MEDIA_CHUNK_BYTES, MEDIA_MAX_BYTES, MEDIA_MAX_PIXELS } from '../src/lib/protocol/workspace-media';
import { PREVIEW_SITE_FILES, previewSiteOwns } from './preview-site';

export const PREVIEW_FILE = 'public/report.html';
export const PREVIEW_TRACE = [
  { type: 'user' as const, text: '生成一个交互式报告' },
  { type: 'assistant' as const, text: '打开 [交互式报告](/work/pairfob/public/report.html)，也可以点击 `public/report.html`。\n\n桌面周报 [运营周报](/work/pairfob/public/dashboard.html)。\n\n构建产物 [站点首页](/work/pairfob/public/site/index.html)。\n\n目录 ~/pairfob，绝对路径 /work/pairfob/public/report.html，主目录文件 `~/pairfob/public/report.html`。\n\n特殊文件 `/work/pairfob/public/report%20draft.html`，空格文件 [My Report](</work/pairfob/public/My Report.html>)。\n\n歧义示例 /work/My Project/report.html。\n\n本地链接 [file URI](file:///work/pairfob/public/report.html)，定位 [第 4 行](file:///work/pairfob/public/report.html:4)。\n\n资源路径 public/app.js，外部链接 [Example](https://example.com)。' },
];
const html = `<!doctype html><html lang="zh"><head><title>Preview acceptance</title>
<link rel="stylesheet" href="./report.css"></head><body>
<h1>交互式报告</h1>
<button id="increment">计数 +1</button><output id="count">0</output>
<button id="next-page">HTML 下一页</button><output id="page">1</output>
<p id="local">Local data pending</p><p id="external">External API pending</p>
<p id="cors">CORS pending</p><p id="isolation">Isolation pending</p>
<p id="module">Module pending</p><p id="full">Full file pending</p>
<img alt="Local vector" src="./icon.svg" width="24" height="24">
<a id="download" download="review.json">下载评审</a>
<script src="./app.js"></script><script type="module" src="./module.js"></script>
${'<!-- full-file integrity padding -->'.repeat(4300)}
<script>document.querySelector('#full').textContent='Full file loaded after 128 KiB';</script>
</body></html>`;
// A page written for a PC, as agents write reports: a fixed desktop canvas,
// no responsive rules. The point is that it is unreadable at a phone's width.
const dashboard = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>运营周报</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 1180px; font: 14px/1.5 -apple-system, "PingFang SC", system-ui, sans-serif; color: #1f2937; background: #f4f6f9; }
  .shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100vh; }
  .side { background: #0f172a; color: #dbe4f3; padding: 24px 20px; }
  .brand { font-weight: 700; font-size: 17px; }
  .nav { list-style: none; margin: 32px 0 0; padding: 0; display: grid; gap: 6px; }
  .nav li { padding: 9px 12px; border-radius: 8px; color: #9fb0c9; }
  .nav li.on { background: rgba(110, 168, 254, .16); color: #e8effb; }
  .main { padding: 26px 30px 40px; }
  h1 { margin: 0; font-size: 22px; }
  .sub { color: #667085; margin: 6px 0 22px; }
  .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
  .card { background: #fff; border: 1px solid #e4e8ef; border-radius: 12px; padding: 16px 18px; }
  .card small { color: #667085; }
  .card b { display: block; font-size: 26px; margin-top: 4px; }
  h2 { font-size: 15px; margin: 26px 0 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e4e8ef; border-radius: 12px; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #eef1f6; white-space: nowrap; }
  th { color: #667085; font-weight: 500; background: #fafbfc; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .up { color: #07883b; } .down { color: #c0392b; }
  .acts { display: flex; align-items: center; gap: 10px; margin: 18px 0 0; }
  .act { font: inherit; padding: 7px 14px; border: 1px solid #d3dae6; border-radius: 8px; background: #fff; color: #1f2937; }
  .act.done { background: #e7f6ee; border-color: #8fd6ac; color: #07883b; }
  .act + output { color: #667085; }
  .hit { position: fixed; right: 24px; bottom: 24px; margin: 0; padding: 8px 14px; border-radius: 999px; background: #e11d48; color: #fff; font-weight: 600; }
</style></head><body><div class="shell">
<aside class="side"><div class="brand">星图数据</div>
<ul class="nav"><li class="on">运营总览</li><li>渠道分析</li><li>留存 cohort</li><li>收入明细</li><li>周报归档</li><li>设置</li></ul></aside>
<main class="main"><h1>第 46 周运营周报</h1><p class="sub">统计区间 2026-11-09 至 2026-11-15 · 数据更新于 11-16 07:30</p>
<div class="cards">
<div class="card"><small>活跃用户</small><b>182,430</b><span class="up">+6.4%</span></div>
<div class="card"><small>新增注册</small><b>12,806</b><span class="up">+3.1%</span></div>
<div class="card"><small>付费转化</small><b>4.82%</b><span class="down">−0.3%</span></div>
<div class="card"><small>周收入</small><b>¥1,286,400</b><span class="up">+8.9%</span></div></div>
<p class="acts"><button class="act" data-probe>标记已读</button><output data-probe-out>未读</output></p>
<h2>渠道明细</h2>
<table><thead><tr><th>渠道</th><th>曝光</th><th>点击</th><th>点击率</th><th>注册</th><th>注册率</th><th>首日留存</th><th>七日留存</th><th>付费用户</th><th>收入</th><th>环比</th></tr></thead>
<tbody>
<tr><td>App Store 搜索</td><td class="num">1,204,882</td><td class="num">86,431</td><td class="num">7.17%</td><td class="num">4,208</td><td class="num">4.87%</td><td class="num">41.2%</td><td class="num">18.6%</td><td class="num">212</td><td class="num">¥286,400</td><td class="num up">+11.2%</td></tr>
<tr><td>小红书</td><td class="num">864,120</td><td class="num">52,308</td><td class="num">6.05%</td><td class="num">2,864</td><td class="num">5.48%</td><td class="num">38.6%</td><td class="num">15.1%</td><td class="num">164</td><td class="num">¥198,200</td><td class="num up">+7.4%</td></tr>
<tr><td>微信朋友圈</td><td class="num">742,006</td><td class="num">41,113</td><td class="num">5.54%</td><td class="num">2,102</td><td class="num">5.11%</td><td class="num">36.9%</td><td class="num">14.8%</td><td class="num">128</td><td class="num">¥162,800</td><td class="num down">−2.1%</td></tr>
<tr><td>B 站</td><td class="num">603,914</td><td class="num">38,206</td><td class="num">6.33%</td><td class="num">1,806</td><td class="num">4.73%</td><td class="num">33.4%</td><td class="num">12.2%</td><td class="num">96</td><td class="num">¥121,600</td><td class="num up">+4.6%</td></tr>
<tr><td>知乎</td><td class="num">512,377</td><td class="num">29,884</td><td class="num">5.83%</td><td class="num">1,322</td><td class="num">4.42%</td><td class="num">31.8%</td><td class="num">11.9%</td><td class="num">74</td><td class="num">¥96,300</td><td class="num down">−1.4%</td></tr>
<tr><td>自然流量</td><td class="num">386,204</td><td class="num">22,140</td><td class="num">5.73%</td><td class="num">1,104</td><td class="num">4.99%</td><td class="num">40.1%</td><td class="num">17.3%</td><td class="num">88</td><td class="num">¥112,400</td><td class="num up">+2.8%</td></tr>
</tbody></table></main></div>
<p class="hit" hidden>已点击页面</p>
<script>document.querySelector('[data-probe]').addEventListener('click', (event) => { event.currentTarget.classList.add('done'); event.currentTarget.textContent = '已读 ✓'; document.querySelector('[data-probe-out]').textContent = '已读 ' + new Date().toLocaleTimeString(); });
document.addEventListener('click', () => { document.querySelector('.hit').hidden = false; });</script>
</body></html>`;
const files: Record<string, string> = {
  ...PREVIEW_SITE_FILES,
  [PREVIEW_FILE]: html,
  'public/dashboard.html': dashboard,
  // The folder lists this page too: it opens as a page, not as the stand-in source of a file nobody wrote.
  'public/index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pairfob</title><link rel="stylesheet" href="./report.css"></head><body><h1>Pairfob</h1><p>The project\'s landing page.</p></body></html>',
  "public/report%20draft.html": html,
  "public/My Report.html": html,
  'public/report.css': '@import "./colors.css"; body { font: 16px system-ui; padding: 20px; margin: 0; } button, a { padding: 12px; display:inline-block; }',
  'public/colors.css': 'body { background: #eef6ff; color: #123; }',
  'public/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="green"/></svg>',
  'public/data.json': '{"message":"Local JSON loaded"}',
  'public/module.js': 'import { label } from "./module-label.js"; document.querySelector("#module").textContent = label;',
  'public/module-label.js': 'export const label = "ES module loaded";',
  'public/app.js': `let n=0; document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(++n);
document.querySelector('#next-page').onclick=()=>{ const page=Number(document.querySelector('#page').textContent)+1; history.pushState({page},''); document.querySelector('#page').textContent=String(page); };
// QA-only control for browser drivers that cannot hit-test an opaque nested iframe.
addEventListener('message',event=>{if(event.source===parent && event.data==='qa-next-page') document.querySelector('#next-page').click();});
addEventListener('popstate',()=>document.querySelector('#page').textContent=String(history.state?.page||1));
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
    /** A path this fixture answers for, so an absent one is missing rather than a stand-in workspace file. */
    owns: (path: string) => Object.hasOwn(files, path) || previewSiteOwns(path),
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
