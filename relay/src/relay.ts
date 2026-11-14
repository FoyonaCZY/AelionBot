// The relay: phones and desktops both connect out to it, so neither needs a public address. It matches a phone to
// its desktop by room and forwards their frames, which are end-to-end encrypted; it holds no keys and stores
// nothing. It also serves the phone app, so a self-hoster deploys one thing.
//
// Desktop connection (RELAY_DESKTOP_PATH): the relay sends { t: 'challenge', nonce }; the desktop answers
// { t: 'auth', key, sig } with its signing key, which fixes its room. Phones then appear as { t: 'open', conn } and
// leave as { t: 'close', conn }; data travels as binary frames prefixed with the 4-byte connection number.
// Phone connection (RELAY_CLIENT_PATH?room=…): binary frames are the phone's payload as is. While the desktop is
// away the phone gets { t: 'offline', since } and stays connected; { t: 'online' } follows when it comes back.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { fromBase64Url, importSigningPublicKey, roomId, utf8, verify } from '../../shared/remote/crypto';
import { RELAY_CLIENT_PATH, RELAY_DESKTOP_PATH } from '../../shared/remote/protocol';

export interface RelayOptions {
  port: number;
  host?: string;
  /** The built phone app; without it only the WebSocket endpoints answer. */
  publicDir?: string;
  /** Phones connected to one room at once. */
  maxClientsPerRoom?: number;
  /** Bytes forwarded per room and UTC day, both directions together; 0 for no limit. */
  dailyBytesPerRoom?: number;
  /** Connections from one address at once. */
  maxConnectionsPerAddress?: number;
  /** Read the client address from X-Forwarded-For (set when a reverse proxy terminates TLS). */
  trustProxy?: boolean;
  log?: (line: string) => void;
}

const FRAME_BYTES = 512 * 1024;
const PING_MS = 25_000;
const AUTH_MS = 10_000;

interface Room {
  id: string;
  desktop?: WebSocket;
  clients: Map<number, WebSocket>;
  /** When the desktop was last connected, for the phones' "last online" line. */
  since?: string;
  day: string;
  bytes: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export interface Relay {
  server: Server;
  /** The port it listens on (useful when started on port 0). */
  port: number;
  stats(): { rooms: number; desktops: number; clients: number };
  close(): Promise<void>;
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const log = options.log || (() => {});
  const maxClients = options.maxClientsPerRoom ?? 8,
    dailyBytes = options.dailyBytesPerRoom ?? 4 * 1024 ** 3,
    maxPerAddress = options.maxConnectionsPerAddress ?? 40;
  const rooms = new Map<string, Room>();
  const perAddress = new Map<string, number>();
  let nextConn = 1;

  const room = (id: string) => {
    let entry = rooms.get(id);
    if (!entry) rooms.set(id, (entry = { id, clients: new Map(), day: today(), bytes: 0 }));
    return entry;
  };
  const forget = (entry: Room) => {
    if (!entry.desktop && !entry.clients.size && !entry.since) rooms.delete(entry.id);
  };
  /** Counts forwarded bytes; false once the room used up its day. */
  const meter = (entry: Room, bytes: number) => {
    const day = today();
    if (entry.day !== day) {
      entry.day = day;
      entry.bytes = 0;
    }
    entry.bytes += bytes;
    return !dailyBytes || entry.bytes <= dailyBytes;
  };
  const send = (socket: WebSocket | undefined, value: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };

  const sockets = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES, perMessageDeflate: false });
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, PING_MS);
  heartbeat.unref();

  function acceptDesktop(socket: WebSocket) {
    const nonce = randomBytes(32).toString('base64url');
    let entry: Room | undefined;
    const timer = setTimeout(() => socket.close(4401, 'auth timeout'), AUTH_MS);
    send(socket, { t: 'challenge', nonce });
    socket.on('message', (data, binary) => {
      if (!entry) {
        if (binary) return socket.close(4400, 'auth first');
        void (async () => {
          try {
            const message = JSON.parse(String(data));
            if (message?.t !== 'auth' || typeof message.key !== 'string' || typeof message.sig !== 'string')
              throw new Error('bad auth');
            const raw = fromBase64Url(message.key),
              key = await importSigningPublicKey(raw);
            if (!(await verify(key, fromBase64Url(message.sig), utf8('aelion-relay-v1:' + nonce))))
              throw new Error('bad signature');
            clearTimeout(timer);
            if (socket.readyState !== WebSocket.OPEN) return;
            entry = room(await roomId(raw));
            // A newer connection of the same desktop replaces the old one (after sleep, a network change…).
            if (entry.desktop && entry.desktop !== socket) entry.desktop.close(4409, 'replaced');
            entry.desktop = socket;
            entry.since = undefined;
            send(socket, { t: 'ready', room: entry.id });
            for (const [conn, client] of entry.clients) {
              send(client, { t: 'online' });
              send(socket, { t: 'open', conn });
            }
          } catch {
            socket.close(4401, 'auth failed');
          }
        })();
        return;
      }
      if (!binary) {
        try {
          const message = JSON.parse(String(data));
          if (message?.t === 'close' && Number.isInteger(message.conn))
            entry.clients.get(message.conn)?.close(4403, 'closed');
        } catch {
          // Ignore what cannot be read.
        }
        return;
      }
      const frame = toBuffer(data);
      if (frame.length < 4) return;
      const client = entry.clients.get(frame.readUInt32BE(0));
      if (!client || client.readyState !== WebSocket.OPEN) return;
      if (!meter(entry, frame.length)) return limit(entry);
      client.send(frame.subarray(4), { binary: true });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!entry || entry.desktop !== socket) return;
      entry.desktop = undefined;
      entry.since = new Date().toISOString();
      for (const client of entry.clients.values()) send(client, { t: 'offline', since: entry.since });
    });
  }

  function acceptClient(socket: WebSocket, id: string) {
    const entry = room(id);
    if (entry.clients.size >= maxClients) {
      socket.close(4429, 'too many devices');
      return forget(entry);
    }
    const conn = nextConn++;
    nextConn = nextConn > 0x7fffffff ? 1 : nextConn;
    entry.clients.set(conn, socket);
    if (entry.desktop) {
      send(socket, { t: 'online' });
      send(entry.desktop, { t: 'open', conn });
    } else send(socket, { t: 'offline', ...(entry.since ? { since: entry.since } : {}) });
    socket.on('message', (data, binary) => {
      if (!binary || !entry.desktop || entry.desktop.readyState !== WebSocket.OPEN) return;
      const payload = toBuffer(data);
      if (!meter(entry, payload.length)) return limit(entry);
      const frame = Buffer.allocUnsafe(payload.length + 4);
      frame.writeUInt32BE(conn, 0);
      payload.copy(frame, 4);
      entry.desktop.send(frame, { binary: true });
    });
    socket.on('close', () => {
      entry.clients.delete(conn);
      send(entry.desktop, { t: 'close', conn });
      forget(entry);
    });
  }

  function limit(entry: Room) {
    for (const client of entry.clients.values()) client.close(4413, 'daily limit');
  }

  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  async function serve(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || '/', 'http://relay');
    if (url.pathname === '/healthz') {
      let desktops = 0,
        clients = 0;
      for (const entry of rooms.values()) {
        desktops += entry.desktop ? 1 : 0;
        clients += entry.clients.size;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, desktops, clients }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405);
      response.end();
      return;
    }
    if (!options.publicDir) {
      response.writeHead(404);
      response.end();
      return;
    }
    const root = resolve(options.publicDir);
    let path = resolve(join(root, decodeURIComponent(url.pathname)));
    if (path !== root && !path.startsWith(root + sep)) {
      response.writeHead(400);
      response.end();
      return;
    }
    let info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) {
      path = join(path, 'index.html');
      info = await stat(path).catch(() => undefined);
    }
    // The app routes inside one page: unknown paths without an extension load it.
    if (!info && !extname(url.pathname)) {
      path = join(root, 'index.html');
      info = await stat(path).catch(() => undefined);
    }
    if (!info?.isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    const name = path.slice(root.length + 1).replace(/\\/g, '/');
    const immutable = name.startsWith('assets/');
    const host = String(request.headers.host || '').replace(/[^A-Za-z0-9.:[\]-]/g, '');
    response.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(name === 'widget-frame.html'
        ? {}
        : {
            'x-frame-options': 'SAMEORIGIN',
            'content-security-policy': [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data:",
              "media-src 'self' blob:",
              `connect-src 'self' wss://${host} ws://${host}`,
              "frame-src 'self'",
              "worker-src 'self'",
              "base-uri 'none'",
              "form-action 'none'",
              "object-src 'none'",
            ].join('; '),
          }),
      ...(name === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
    });
    if (request.method === 'HEAD') return void response.end();
    response.end(await readFile(path));
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://relay');
    const address = clientAddress(request, options.trustProxy);
    const count = perAddress.get(address) || 0;
    const room = url.searchParams.get('room') || '';
    const desktop = url.pathname === RELAY_DESKTOP_PATH,
      client = url.pathname === RELAY_CLIENT_PATH && /^[A-Za-z0-9_-]{16,64}$/.test(room);
    if ((!desktop && !client) || count >= maxPerAddress) {
      socket.write('HTTP/1.1 ' + (count >= maxPerAddress ? '429 Too Many Requests' : '404 Not Found') + '\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      perAddress.set(address, count + 1);
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        const left = (perAddress.get(address) || 1) - 1;
        if (left > 0) perAddress.set(address, left);
        else perAddress.delete(address);
      });
      if (desktop) acceptDesktop(ws);
      else acceptClient(ws, room);
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  log(`relay listening on ${options.host ?? '127.0.0.1'}:${port}`);
  return {
    server,
    port,
    stats() {
      let desktops = 0,
        clients = 0;
      for (const entry of rooms.values()) {
        desktops += entry.desktop ? 1 : 0;
        clients += entry.clients.size;
      }
      return { rooms: rooms.size, desktops, clients };
    },
    async close() {
      clearInterval(heartbeat);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

const today = () => new Date().toISOString().slice(0, 10);
function toBuffer(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
function clientAddress(request: IncomingMessage, trustProxy?: boolean) {
  const forwarded = trustProxy
    ? String(request.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim()
    : '';
  return forwarded || request.socket.remoteAddress || '';
}
