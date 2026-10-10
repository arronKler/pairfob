/** Only the fixed, source-free runner receives this policy. Enforced even when opened top-level. */
export const PREVIEW_PATH = '/preview/runner.html';
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-downloads allow-popups';
export const PREVIEW_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': `default-src 'none'; script-src https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; style-src https: http: data: blob: 'unsafe-inline'; img-src https: http: data: blob:; font-src https: http: data: blob:; media-src https: http: data: blob:; connect-src https: http: wss: ws: data: blob:; frame-src https: http: data: blob:; worker-src blob: data:; object-src 'none'; base-uri https: http:; form-action https: http:; frame-ancestors 'self'; sandbox ${PREVIEW_SANDBOX};`,
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store, no-transform',
};
