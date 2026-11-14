// The phone app, a PWA built on its own. scripts/build-mobile.mjs adds the service worker and the widget frame.
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  root,
  base: '/',
  publicDir: 'public',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
});
