import { resolve } from "node:path";
import { PREVIEW_HEADERS, PREVIEW_PATH } from "../workers/pairfob-origin/src/preview-policy";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The native shell does not inherit the Worker's CSP, so the bundle carries
 * one. Only the configured relay (and its WebSocket form) may be reached; the
 * app's own assets, Wasm and blob workers stay local.
 */
function nativeCspPlugin(relayOrigin: string): Plugin {
  const parsed = new URL(relayOrigin);
  const socket = `${parsed.protocol === "https:" ? "wss" : "ws"}://${parsed.host}`;
  const policy = [
    "default-src 'self'",
    `connect-src 'self' ${parsed.origin} ${socket}`,
    "img-src 'self' data: blob:",
    "media-src blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  return {
    name: "pairfob-native-csp",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n  </head>`,
      );
    },
  };
}

const nativeBuild = process.env.VITE_PAIRFOB_NATIVE === "1";
const relayOrigin = process.env.VITE_PAIRFOB_RELAY_ORIGIN || "https://pairfob.com";

export default defineConfig({
  build: {
    manifest: true,
    ...(nativeBuild
      ? {}
      : {
          rollupOptions: {
            input: {
              index: resolve(__dirname, "index.html"),
              demo: resolve(__dirname, "demo.html"),
            },
          },
        }),
  },
  plugins: [react(), tailwindcss(), nativeBuild && nativeCspPlugin(relayOrigin), {
    name: 'preview-response-policy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === PREVIEW_PATH) {
          for (const [key, value] of Object.entries(PREVIEW_HEADERS)) res.setHeader(key, value);
        }
        if (req.url === '/qa/preview-api' || req.url === '/qa/preview-no-cors') {
          if (req.url === '/qa/preview-api') res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ message: 'External API loaded' }));
          return;
        }
        next();
      });
    },
  }],
  server: { host: "127.0.0.1", port: 5173 },
});
