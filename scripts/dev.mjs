import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildDesktopHelper } from './build-desktop-helper.mjs';
import { VIDEO_RUNTIME_APP_ENTRIES, VIDEO_RUNTIME_ENTRIES, buildVideoRuntime } from './build-video-runtime.mjs';
const require = createRequire(import.meta.url);
await build({
  entryPoints: ['electron/windows/web-preview-preload.ts'],
  outfile: 'dist-electron/web-preview-preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await build({
  entryPoints: ['electron/windows/preview-feedback-preload.ts'],
  outfile: 'dist-electron/preview-feedback-preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
// Phones' direct connections are answered in a hidden window with this preload (electron/windows/remote-direct.ts).
await build({
  entryPoints: ['electron/windows/remote-direct-preload.ts'],
  outfile: 'dist-electron/remote-direct-preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
// Hidden sandboxed Chromium video engine preload (electron/windows/video-engine-window.ts).
await build({
  entryPoints: ['electron/windows/video-engine-preload.ts'],
  outfile: 'dist-electron/video-engine-preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'electron-updater', 'ssh2'],
  sourcemap: true,
});
await build({
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await build({
  entryPoints: ['electron/core/file-search-worker.ts'],
  outfile: 'dist-electron/file-search-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
});
await build({
  entryPoints: ['electron/core/context/token-worker.ts'],
  outfile: 'dist-electron/token-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['js-tiktoken'],
});
await build({
  entryPoints: ['electron/core/memory/embedding-worker.ts'],
  outfile: 'dist-electron/embedding/embedding-worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
  cpSync(`node_modules/onnxruntime-web/dist/${file}`, `dist-electron/embedding/${file}`);
await buildVideoRuntime({ outDir: 'dist/video-runtime', minify: false });
// On macOS, host Computer Use needs its Swift helper; without the Xcode tools the app runs without that feature.
try {
  buildDesktopHelper();
} catch (error) {
  console.warn('Desktop helper not built; host Computer Use is unavailable in this run:', error.message);
}
const videoRuntimeFiles = new Set([
  ...VIDEO_RUNTIME_ENTRIES.map((entry) => entry.name),
  ...VIDEO_RUNTIME_APP_ENTRIES.map((entry) => entry.name),
]);
const videoRuntimePlugin = {
  name: 'aelion-video-runtime-dev',
  configureServer(devServer) {
    devServer.middlewares.use('/video-runtime', (req, res, next) => {
      const cleanPath = (req.url || '').split('?')[0].replace(/^\/+/, '');
      if (!videoRuntimeFiles.has(cleanPath)) return next();
      const filePath = join('dist/video-runtime', cleanPath);
      if (!existsSync(filePath)) return next();
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(readFileSync(filePath));
    });
  },
};
const server = await createServer({
  plugins: [videoRuntimePlugin],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
await server.listen();
const env = { ...process.env, AELION_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code || 0);
});
