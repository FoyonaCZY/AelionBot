import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdirSync } from 'node:fs';
mkdirSync('dist-electron', { recursive: true });
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'electron-updater', 'ssh2', '@modelcontextprotocol/sdk', 'yaml', 'smol-toml', 'jsonc-parser', 'js-tiktoken'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
await build({ entryPoints: ['electron/core/file-search-worker.ts'], outfile: 'dist-electron/file-search-worker.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
await viteBuild({ base: './', build: { outDir: 'dist' } });
