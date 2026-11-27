import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const VIDEO_RUNTIME_ENTRIES = [
  {
    name: 'webgl2-worker.js',
    entry: 'packages/aelion-sdk/renderer-worker/src/webgl2-worker.ts',
  },
  {
    name: 'mux-export-worker.js',
    entry: 'packages/aelion-sdk/export/src/mux-export-worker.ts',
  },
  {
    name: 'pcm-player.worklet.js',
    entry: 'packages/aelion-sdk/audio/src/pcm-player.worklet.ts',
  },
  {
    name: 'pcm-message-player.worklet.js',
    entry: 'packages/aelion-sdk/audio/src/pcm-message-player.worklet.ts',
  },
];

export const VIDEO_RUNTIME_APP_ENTRIES = [
  {
    name: 'engine-entry.js',
    entry: 'electron/windows/video-engine-entry.ts',
    optional: false,
  },
  {
    name: 'player-entry.js',
    entry: 'src/preview/video-player-frame.ts',
    optional: true,
  },
];

/**
 * Bundles the 4 AelionSDK browser Worker / AudioWorklet runtime modules plus the hidden engine
 * and preview player entries into a self-contained directory (default: `dist/video-runtime/`).
 */
export async function buildVideoRuntime({ outDir = 'dist/video-runtime', minify = true } = {}) {
  mkdirSync(outDir, { recursive: true });
  const targets = [
    ...VIDEO_RUNTIME_ENTRIES,
    ...VIDEO_RUNTIME_APP_ENTRIES.filter((item) => !item.optional || existsSync(item.entry)),
  ];
  await Promise.all(
    targets.map(({ name, entry }) =>
      build({
        entryPoints: [entry],
        outfile: join(outDir, name),
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2023',
        minify,
      }),
    ),
  );
  return targets.map(({ name }) => join(outDir, name));
}
