/**
 * A built site as a bundler leaves it, for the HTML preview: root-relative
 * assets beside the page, a favicon nobody shipped, and a page that loads more
 * of itself while it runs (XHR, images set by script, inserted markup, a late
 * stylesheet, a framed local page) and links to a sibling page.
 */
export const PREVIEW_SITE = 'public/site/index.html';

const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Built site</title>
<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/assets/index.css">
<script type="module" crossorigin src="/assets/index.js"></script></head><body>
<h1>构建产物</h1>
<p id="root-css">Root CSS pending</p><p id="xhr">XHR pending</p><p id="late-css">Late CSS pending</p>
<p>Script image <span id="script-img"></span></p><p>Markup image <span id="markup-img"></span></p>
<iframe id="part" src="./part.html" title="Local part" height="80"></iframe>
<p><a id="about" href="./about.html">关于页 →</a></p>
</body></html>`;

const entry = `
const mark = (id, text) => { document.getElementById(id).textContent = text; };
if (getComputedStyle(document.body).borderTopStyle === 'solid') mark('root-css', 'Root CSS loaded');
const xhr = new XMLHttpRequest();
xhr.open('GET', './data/info.json');
xhr.responseType = 'json';
xhr.onload = () => mark('xhr', xhr.response.message);
xhr.onerror = () => mark('xhr', 'XHR failed');
xhr.send();
const img = new Image(24, 24);
img.alt = 'Script logo';
img.onload = () => img.dataset.loaded = 'true';
img.src = 'logo.svg';
document.getElementById('script-img').append(img);
document.getElementById('markup-img').innerHTML = '<img alt="Markup logo" width="24" height="24" src="logo.svg">';
const sheet = document.createElement('link');
sheet.rel = 'stylesheet';
sheet.onload = () => mark('late-css', getComputedStyle(document.querySelector('h1')).textDecorationLine === 'underline' ? 'Late CSS loaded' : 'Late CSS empty');
sheet.href = '/assets/late.css';
document.head.append(sheet);
`;

const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" rx="6" fill="#2563eb"/></svg>';

export const PREVIEW_SITE_FILES: Record<string, string> = {
  [PREVIEW_SITE]: page,
  'public/site/assets/index.js': entry,
  'public/site/assets/index.css': 'body { font: 16px system-ui; padding: 20px; margin: 0; border-top: 4px solid #2563eb; } a { padding: 12px; display: inline-block; }',
  'public/site/assets/late.css': 'h1 { text-decoration: underline; background: url(./stripe.svg) repeat-x bottom; }',
  'public/site/assets/stripe.svg': logo,
  'public/site/logo.svg': logo,
  'public/site/data/info.json': '{"message":"XHR JSON loaded"}',
  'public/site/part.html': '<!doctype html><html><body style="margin:0;font:14px system-ui"><img alt="Part logo" src="logo.svg" width="16"> <span id="part-data">Part pending</span>'
    + '<script>fetch("./data/info.json").then(r => r.json()).then(d => document.getElementById("part-data").textContent = "Part: " + d.message)</script></body></html>',
  'public/site/about.html': '<!doctype html><html lang="zh"><head><link rel="stylesheet" href="/assets/index.css"></head><body><h1>关于</h1><p id="about-page">About page opened</p><a href="./index.html">← 首页</a></body></html>',
};

/** Paths the site fixture answers for, present or not: everything else is the general workspace fixture's. */
export function previewSiteOwns(path: string): boolean {
  // The site itself, and every place its root-relative references are tried before it.
  return path.startsWith('public/site/') || /^(public\/)?(assets\/|data\/|favicon\.ico$)/.test(path);
}
