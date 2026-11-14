// Builds the phone app (mobile/) into mobile/dist. With --relay, builds the relay into relay/dist as one file,
// relay.cjs, with the phone app beside it in relay/dist/public, ready to copy to a server (see relay/README.md).
import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';

const relay = process.argv.includes('--relay');
const out = resolve(relay ? 'relay/dist/public' : 'mobile/dist');

await viteBuild({
  configFile: resolve('mobile/vite.config.ts'),
  logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true },
});
// The service worker is a classic script: module workers are not supported everywhere web push is.
await build({
  entryPoints: ['mobile/src/sw.ts'],
  outfile: `${out}/sw.js`,
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
});
// Inline HTML widgets in replies run in this sandboxed frame (see src/chat/MessageVisual.tsx).
cpSync('public/widget-frame.html', `${out}/widget-frame.html`);

if (relay)
  await build({
    entryPoints: ['relay/src/main.ts'],
    outfile: 'relay/dist/relay.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Optional native speed-ups of ws; it works without them.
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'eof',
  });
// relay/dist is the whole deployment: relay.cjs, public/ and deploy/install.sh.
if (relay) cpSync('relay/deploy', 'relay/dist/deploy', { recursive: true });
console.log(relay ? 'relay/dist ready' : 'mobile/dist ready');
