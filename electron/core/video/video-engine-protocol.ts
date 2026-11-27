// Privileged aelion-video:// protocol handler serving the hidden video engine, preview player iframe,
// bundled AelionSDK workers/worklets, project JSON, and HTTP 206 byte-range media assets.
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { Protocol } from 'electron';
import { VIDEO_RUNTIME_DIR } from '../../../shared/types/video-studio-types';
import { VIDEO_ENGINE_SCHEME, type VideoProjects } from './video-projects';

const ENGINE_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' aelion-video: aelion-media:; img-src 'self' data: blob:; media-src 'self' blob: aelion-video: aelion-media:; style-src 'self' 'unsafe-inline';";

const PLAYER_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' aelion-video: aelion-media:; img-src 'self' data: blob:; media-src 'self' blob: aelion-video: aelion-media:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self' file: http://127.0.0.1:*;";

const ENGINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ENGINE_CSP}">
<title>Aelion Video Engine</title>
</head>
<body>
<script type="module" src="/${VIDEO_RUNTIME_DIR}/engine-entry.js"></script>
</body>
</html>
`;

const PLAYER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aelion Video Player</title>
<style>
  html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
  canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/${VIDEO_RUNTIME_DIR}/player-entry.js"></script>
</body>
</html>
`;

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range, Content-Type',
  'access-control-expose-headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type',
  'cross-origin-resource-policy': 'cross-origin',
};

const RUNTIME_MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

interface EphemeralMediaEntry {
  path?: string;
  bytes?: Buffer;
  mimeType: string;
}

export class VideoMediaTokenRegistry {
  private readonly entries = new Map<string, EphemeralMediaEntry>();

  registerFile(path: string, mimeType: string): { token: string; url: string; release: () => void } {
    const token = randomUUID();
    this.entries.set(token, { path, mimeType });
    return {
      token,
      url: `${VIDEO_ENGINE_SCHEME}://media/${token}`,
      release: () => {
        this.entries.delete(token);
      },
    };
  }

  registerBuffer(bytes: Buffer, mimeType: string): { token: string; url: string; release: () => void } {
    const token = randomUUID();
    this.entries.set(token, { bytes, mimeType });
    return {
      token,
      url: `${VIDEO_ENGINE_SCHEME}://media/${token}`,
      release: () => {
        this.entries.delete(token);
      },
    };
  }

  get(token: string): EphemeralMediaEntry | undefined {
    return this.entries.get(token);
  }

  clear(): void {
    this.entries.clear();
  }
}

function parseByteRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    return 'unsatisfiable';
  }
  return { start, end };
}

function serveFileRangeRequest(filePath: string, mimeType: string, request: Request): Response {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }
  if (!existsSync(filePath)) {
    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }
  const size = statSync(filePath).size;
  const baseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    'content-type': mimeType,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, size);
    if (parsed === 'unsatisfiable' || size === 0) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
      });
    }
    if (parsed) {
      const length = parsed.end - parsed.start + 1;
      const headers = {
        ...baseHeaders,
        'content-length': String(length),
        'content-range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      };
      if (method === 'HEAD') return new Response(null, { status: 206, headers });
      const stream = Readable.toWeb(
        createReadStream(filePath, { start: parsed.start, end: parsed.end }),
      ) as ReadableStream;
      return new Response(stream, { status: 206, headers });
    }
  }
  const headers = { ...baseHeaders, 'content-length': String(size) };
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, { status: 200, headers });
}

function serveBufferRangeRequest(bytes: Buffer, mimeType: string, request: Request): Response {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }
  const size = bytes.byteLength;
  const baseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    'content-type': mimeType,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, size);
    if (parsed === 'unsatisfiable' || size === 0) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
      });
    }
    if (parsed) {
      const slice = bytes.subarray(parsed.start, parsed.end + 1);
      const headers = {
        ...baseHeaders,
        'content-length': String(slice.byteLength),
        'content-range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      };
      return new Response(method === 'HEAD' ? null : new Uint8Array(slice), { status: 206, headers });
    }
  }
  const headers = { ...baseHeaders, 'content-length': String(size) };
  return new Response(method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers });
}

export interface VideoProtocolDeps {
  runtimeDir: string;
  projects: VideoProjects;
  mediaTokens: VideoMediaTokenRegistry;
}

export function createVideoEngineProtocolHandler(deps: VideoProtocolDeps): (request: Request) => Response {
  return (request: Request): Response => {
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad Request', { status: 400, headers: CORS_HEADERS });
    }

    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/^\/+/, '');

    const serveRuntimeFile = (rawName: string): Response => {
      let fileName: string;
      try {
        fileName = decodeURIComponent(rawName);
      } catch {
        return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
      }
      if (
        !fileName ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        fileName.includes('..') ||
        !/^[A-Za-z0-9._-]+$/.test(fileName)
      ) {
        return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
      }
      const ext = extname(fileName).toLowerCase();
      const mime = RUNTIME_MIME[ext];
      if (!mime) return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
      const filePath = join(deps.runtimeDir, fileName);
      if (!existsSync(filePath)) return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
      const body = method === 'HEAD' ? null : readFileSync(filePath);
      const size = statSync(filePath).size;
      return new Response(body, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'content-type': mime,
          'content-length': String(size),
          'cache-control': 'no-store',
        },
      });
    };

    // 1. Hidden video engine page + same-origin /video-runtime/* for Workers/Worklets
    if (host === 'engine') {
      if (pathname === '' || pathname === 'index.html') {
        return new Response(method === 'HEAD' ? null : ENGINE_HTML, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': ENGINE_CSP,
            'cache-control': 'no-store',
          },
        });
      }
      if (pathname.startsWith(`${VIDEO_RUNTIME_DIR}/`)) {
        return serveRuntimeFile(pathname.slice(VIDEO_RUNTIME_DIR.length + 1));
      }
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }

    // 2. Preview player iframe page + same-origin /video-runtime/* for Workers/Worklets
    if (host === 'player') {
      if (pathname === '' || pathname === 'index.html') {
        return new Response(method === 'HEAD' ? null : PLAYER_HTML, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': PLAYER_CSP,
            'cache-control': 'no-store',
          },
        });
      }
      if (pathname.startsWith(`${VIDEO_RUNTIME_DIR}/`)) {
        return serveRuntimeFile(pathname.slice(VIDEO_RUNTIME_DIR.length + 1));
      }
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }

    // 3. Direct aelion-video://video-runtime/<file> access
    if (host === VIDEO_RUNTIME_DIR) {
      return serveRuntimeFile(pathname);
    }

    // 4. Project JSON + asset URL map
    if (host === 'project') {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[1] === 'project.json') {
        try {
          const projectId = decodeURIComponent(parts[0]!);
          const payload = deps.projects.readProjectJson(projectId);
          const json = JSON.stringify(payload);
          return new Response(method === 'HEAD' ? null : json, {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          });
        } catch {
          return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
        }
      }
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }

    // 5. Project asset byte-range streaming
    if (host === 'asset') {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length === 2) {
        try {
          const projectId = decodeURIComponent(parts[0]!);
          const assetId = decodeURIComponent(parts[1]!);
          const resolved = deps.projects.resolveAssetPath(projectId, assetId);
          return serveFileRangeRequest(resolved.path, resolved.mimeType, request);
        } catch {
          return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
        }
      }
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }

    // 6. Ad-hoc media token byte-range streaming (for mediaAnalyze / mediaPoster)
    if (host === 'media') {
      const token = pathname.split('/')[0] || '';
      const entry = deps.mediaTokens.get(token);
      if (!entry) return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
      if (entry.path) return serveFileRangeRequest(entry.path, entry.mimeType, request);
      if (entry.bytes) return serveBufferRangeRequest(entry.bytes, entry.mimeType, request);
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  };
}

export function registerVideoEngineProtocol(protocol: Protocol, deps: VideoProtocolDeps): () => void {
  const handler = createVideoEngineProtocolHandler(deps);
  protocol.handle(VIDEO_ENGINE_SCHEME, handler);
  return () => {
    try {
      protocol.unhandle(VIDEO_ENGINE_SCHEME);
    } catch {
      // Ignore during shutdown
    }
  };
}
