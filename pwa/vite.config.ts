import { PREVIEW_HEADERS, PREVIEW_PATH } from "../workers/pairfob-origin/src/preview-policy";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss(), {
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
