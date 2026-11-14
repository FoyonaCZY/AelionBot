import { verifyDesignSystems } from './verify-design-systems.mjs';
verifyDesignSystems();
import { verifyDesignCraft } from './verify-design-craft.mjs';
verifyDesignCraft();
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdirSync, cpSync } from 'node:fs';
mkdirSync('dist-electron', { recursive: true });
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
await build({
  entryPoints: ['./electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: [
    'electron',
    'node-pty',
    'quickjs-emscripten',
    'electron-updater',
    // Feishu connectors load it on first use; see electron/core/connectors/adapters/feishu.ts.
    '@larksuiteoapi/node-sdk',
    'ssh2',
    '@modelcontextprotocol/sdk',
    'yaml',
    'smol-toml',
    'jsonc-parser',
    'js-tiktoken',
  ],
  sourcemap: true,
});
// Headless CLI: the same core without Electron; run with node dist-electron/cli.cjs.
await build({
  entryPoints: ['./electron/cli.ts'],
  outfile: 'dist-electron/cli.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: [
    'electron',
    'node-pty',
    'quickjs-emscripten',
    'ssh2',
    '@modelcontextprotocol/sdk',
    'yaml',
    'smol-toml',
    'jsonc-parser',
    'js-tiktoken',
  ],
  sourcemap: true,
});
await build({
  entryPoints: ['./electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await build({
  entryPoints: ['./electron/core/file-search-worker.ts'],
  outfile: 'dist-electron/file-search-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
});
await build({
  entryPoints: ['./electron/core/context/token-worker.ts'],
  outfile: 'dist-electron/token-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['js-tiktoken'],
});
await build({
  entryPoints: ['./electron/core/code-worker.ts'],
  outfile: 'dist-electron/code-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['quickjs-emscripten'],
});
// The local embedding model's thread. ONNX Runtime finds its WASM next to the module, so this one stays an ES module,
// unpacked from the app archive with the WASM files beside it.
await build({
  entryPoints: ['./electron/core/memory/embedding-worker.ts'],
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
await viteBuild({ base: './', build: { outDir: 'dist' } });

for (const folder of ['cmaps', 'standard_fonts', 'wasm'])
  cpSync(`node_modules/pdfjs-dist/${folder}`, `dist/pdf-assets/${folder}`, { recursive: true });
