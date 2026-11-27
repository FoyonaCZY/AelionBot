import { randomBytes } from 'node:crypto';
import { createReadStream, lstatSync, statSync } from 'node:fs';
import { ATTACHMENT_LIMITS } from '../../../shared/types/attachment-types';

export const MEDIA_STREAM_SCHEME = 'aelion-media';
const MEDIA_HOST = 'media';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_FILE_ENTRIES = 64;
const MAX_BUFFER_ENTRIES = 4;
const CHUNK_BYTES = 256 * 1024;

export type MediaStreamSource =
  { kind: 'file'; path: string; size: number; mime: string } | { kind: 'buffer'; bytes: Buffer; mime: string };

interface MediaEntry {
  token: string;
  key?: string;
  source: MediaStreamSource;
}

type ByteRange = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

export function parseByteRange(header: string | null, total: number): ByteRange {
  if (!header) return { kind: 'full' };
  const trimmed = header.trim();
  if (!/^bytes=/i.test(trimmed)) return { kind: 'full' };
  const spec = trimmed.slice(6).trim();
  if (spec.includes(',')) return { kind: 'full' };
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return { kind: 'unsatisfiable' };
  if (total <= 0) return { kind: 'unsatisfiable' };
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(match[1]);
  const rawEnd = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(rawEnd) || start >= total || start > rawEnd)
    return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(rawEnd, total - 1) };
}

function fileBody(path: string, start: number, end: number) {
  const stream = createReadStream(path, { start, end, highWaterMark: CHUNK_BYTES });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        try {
          controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          if ((controller.desiredSize ?? 0) <= 0) stream.pause();
        } catch {
          stream.destroy();
        }
      });
      stream.on('end', () => {
        try {
          controller.close();
        } catch {}
      });
      stream.on('error', (error) => {
        try {
          controller.error(error);
        } catch {}
      });
    },
    pull() {
      stream.resume();
    },
    cancel() {
      stream.destroy();
    },
  });
}

function sameSource(a: MediaStreamSource, b: MediaStreamSource) {
  if (a.kind !== b.kind || a.mime !== b.mime) return false;
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path && a.size === b.size;
  return a.kind === 'buffer' && b.kind === 'buffer' && a.bytes === b.bytes;
}

/**
 * Serves explicitly previewed audio/video over a custom Electron protocol with HTTP Range streaming,
 * avoiding base64 data URLs and whole-file IPC copies for large media attachments.
 */
export class MediaStreamRegistry {
  private byToken = new Map<string, MediaEntry>();
  private byKey = new Map<string, string>();

  register(source: MediaStreamSource, key?: string): string {
    if (key) {
      const existingToken = this.byKey.get(key);
      const existing = existingToken ? this.byToken.get(existingToken) : undefined;
      if (existing && sameSource(existing.source, source)) {
        this.touch(existing);
        return this.url(existing.token);
      }
      if (existing) this.delete(existing.token);
    }
    const token = randomBytes(18).toString('base64url');
    const entry: MediaEntry = { token, key, source };
    this.byToken.set(token, entry);
    if (key) this.byKey.set(key, token);
    this.evict();
    return this.url(token);
  }

  private url(token: string) {
    return `${MEDIA_STREAM_SCHEME}://${MEDIA_HOST}/${token}`;
  }

  private touch(entry: MediaEntry) {
    this.byToken.delete(entry.token);
    this.byToken.set(entry.token, entry);
  }

  private delete(token: string) {
    const entry = this.byToken.get(token);
    if (!entry) return;
    this.byToken.delete(token);
    if (entry.key && this.byKey.get(entry.key) === token) this.byKey.delete(entry.key);
  }

  private evict() {
    let files = 0,
      buffers = 0,
      bufferBytes = 0;
    const entries = [...this.byToken.values()];
    for (const entry of entries) {
      if (entry.source.kind === 'file') files++;
      else {
        buffers++;
        bufferBytes += entry.source.bytes.length;
      }
    }
    for (const entry of entries) {
      if (entry.source.kind === 'file' && files > MAX_FILE_ENTRIES) {
        this.delete(entry.token);
        files--;
      } else if (
        entry.source.kind === 'buffer' &&
        (buffers > MAX_BUFFER_ENTRIES || bufferBytes > ATTACHMENT_LIMITS.totalBytes)
      ) {
        this.delete(entry.token);
        buffers--;
        bufferBytes -= entry.source.bytes.length;
      }
    }
  }

  handle(request: Request): Response {
    const corsHeaders: Record<string, string> = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range, Content-Type',
      'access-control-expose-headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type',
      'cross-origin-resource-policy': 'cross-origin',
    };
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405, headers: corsHeaders });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 404, headers: corsHeaders });
    }
    if (url.protocol !== MEDIA_STREAM_SCHEME + ':' || url.hostname !== MEDIA_HOST)
      return new Response(null, { status: 404, headers: corsHeaders });
    const token = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    if (!TOKEN_PATTERN.test(token)) return new Response(null, { status: 404, headers: corsHeaders });
    const entry = this.byToken.get(token);
    if (!entry) return new Response(null, { status: 404, headers: corsHeaders });
    this.touch(entry);

    const source = entry.source;
    let total: number;
    if (source.kind === 'file') {
      try {
        const link = lstatSync(source.path);
        const stat = statSync(source.path);
        if (link.isSymbolicLink() || !stat.isFile() || stat.size !== source.size)
          return new Response(null, { status: 404, headers: corsHeaders });
        total = stat.size;
      } catch {
        return new Response(null, { status: 404, headers: corsHeaders });
      }
    } else {
      total = source.bytes.length;
    }

    const range = parseByteRange(request.headers.get('range'), total);
    const headers: Record<string, string> = {
      ...corsHeaders,
      'content-type': source.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (range.kind === 'unsatisfiable') {
      headers['content-range'] = `bytes */${total}`;
      return new Response(null, { status: 416, headers });
    }
    const start = range.kind === 'partial' ? range.start : 0;
    const end = range.kind === 'partial' ? range.end : Math.max(0, total - 1);
    const length = total === 0 ? 0 : end - start + 1;
    const status = range.kind === 'partial' ? 206 : 200;
    headers['content-length'] = String(length);
    if (range.kind === 'partial') headers['content-range'] = `bytes ${start}-${end}/${total}`;
    if (method === 'HEAD' || length === 0) return new Response(null, { status, headers });
    if (source.kind === 'buffer') {
      return new Response(new Uint8Array(source.bytes.subarray(start, end + 1)), { status, headers });
    }
    return new Response(fileBody(source.path, start, end), { status, headers });
  }
}
