// The phone app, a PWA built on its own. scripts/build-mobile.mjs adds the service worker and the widget frame.
import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * noVNC checks H.264 support by decoding a frame with a top-level await, so nothing that imports it loads until the
 * decoder answers. Some phones' decoders never do, and the work computer screen stayed black. The check runs in the
 * background instead; until it answers, the stream does not offer H.264.
 */
const novncDecodeCheck: Plugin = {
  name: 'novnc-decode-check',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('/@novnc/novnc/core/util/browser.js')) return;
    const line = 'supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();';
    if (!code.includes(line)) throw new Error('noVNC changed its H.264 check: review novncDecodeCheck');
    return code.replace(
      line,
      '_checkWebCodecsH264DecodeSupport().then((value) => { supportsWebCodecsH264Decode = value; }, () => {});',
    );
  },
};

export default defineConfig({
  root,
  base: '/',
  publicDir: 'public',
  plugins: [novncDecodeCheck],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
});
