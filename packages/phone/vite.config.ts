import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {cpSync, createReadStream, existsSync, statSync} from 'fs';
import {defineConfig, loadEnv} from 'vite';

const excalidrawFontsDir = path.resolve(__dirname, '../../node_modules/@excalidraw/excalidraw/dist/prod/fonts');

// Excalidraw loads language/font subsets dynamically. Keep them out of the
// initial Phone bundle, serve them on demand in dev, and copy them beside the
// production build. This follows the package's self-hosting contract without
// committing 14 MB of generated dependency assets into Bytelight's source tree.
function excalidrawAssets() {
  return {
    name: 'bytelight-excalidraw-assets',
    configureServer(server: any) {
      server.middlewares.use('/excalidraw-assets', (req: any, res: any, next: () => void) => {
        try {
          const relative = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
          const candidate = path.resolve(excalidrawFontsDir, relative);
          if (!candidate.startsWith(`${excalidrawFontsDir}${path.sep}`) || !existsSync(candidate) || !statSync(candidate).isFile()) {
            next();
            return;
          }
          res.setHeader('Content-Type', candidate.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          createReadStream(candidate).pipe(res);
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      if (!existsSync(excalidrawFontsDir)) return;
      cpSync(excalidrawFontsDir, path.resolve(__dirname, 'dist/excalidraw-assets'), {recursive: true});
    },
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  // Bytelight backend — the phone proxies /api and /ws to it in dev so the
  // page and the WebSocket share an origin (satisfies the backend's Origin
  // allowlist). Default 3002 matches the backend config.ts default.
  const backendPort = env.VITE_BACKEND_PORT || '3002';
  const httpTarget = `http://localhost:${backendPort}`;
  const wsTarget = `ws://localhost:${backendPort}`;
  return {
    // The front door: served at the bare address (old /phone/ links redirect
    // here; see server.ts).
    base: '/',
    plugins: [react(), tailwindcss(), excalidrawAssets()],
    define: {
      'process.env.VITE_WORKER_URL': JSON.stringify(env.VITE_WORKER_URL),
      'process.env.IS_PREACT': JSON.stringify(false),
    },
    resolve: {
      // Excalidraw is lazy-loaded, but it still needs to share the Phone's
      // single React runtime when Vite resolves the workspace dependency tree.
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 5174,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api': httpTarget,
        '/emojis': httpTarget,
        '/stickers': httpTarget,
        '/ws': {target: wsTarget, ws: true},
      },
    },
  };
});
