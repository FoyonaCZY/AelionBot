// This computer's connection to the relay: it proves it owns its room, then receives each phone that connects as a
// numbered connection. It reconnects on its own after a drop, sleep or network change.
import WebSocket from 'ws';
import { sign, toBase64Url, utf8 } from '../../../shared/remote/crypto';
import { RELAY_DESKTOP_PATH, relaySocketUrl } from '../../../shared/remote/protocol';

type RelayStatus = 'connecting' | 'online' | 'error';
export interface RelayLinkHandlers {
  open(conn: number): void;
  close(conn: number): void;
  frame(conn: number, data: Buffer): void;
  status(status: RelayStatus, issue?: string): void;
}

const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const PING_MS = 25_000;

export class RelayLink {
  private socket?: WebSocket;
  private retries = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private stopped = false;
  room?: string;

  constructor(
    private readonly url: string,
    private readonly key: { publicKey: Uint8Array; privateKey: CryptoKey },
    private readonly handlers: RelayLinkHandlers,
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.on('error', () => {});
    socket?.terminate();
  }

  /** Drops the current connection and connects again now, e.g. after the computer woke up. */
  reconnect() {
    if (this.stopped) return;
    this.socket?.terminate();
  }

  send(conn: number, data: Uint8Array) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    const frame = Buffer.allocUnsafe(data.length + 4);
    frame.writeUInt32BE(conn, 0);
    frame.set(data, 4);
    socket.send(frame, { binary: true });
    return true;
  }

  /** Asks the relay to disconnect one phone. */
  kick(conn: number) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ t: 'close', conn }));
  }

  private connect() {
    if (this.stopped) return;
    this.handlers.status('connecting');
    const socket = new WebSocket(relaySocketUrl(this.url, RELAY_DESKTOP_PATH), {
      handshakeTimeout: 15_000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    const live = new Set<number>();
    let ready = false,
      alive = true;
    socket.on('message', (data, binary) => {
      if (binary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (frame.length >= 4 && live.has(frame.readUInt32BE(0)))
          this.handlers.frame(frame.readUInt32BE(0), frame.subarray(4));
        return;
      }
      let message: { t?: string; nonce?: string; room?: string; conn?: number };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.t === 'challenge' && typeof message.nonce === 'string') {
        void sign(this.key.privateKey, utf8('aelion-relay-v1:' + message.nonce)).then((signature) => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({ t: 'auth', key: toBase64Url(this.key.publicKey), sig: toBase64Url(signature) }),
            );
        });
      } else if (message.t === 'ready') {
        ready = true;
        this.retries = 0;
        this.room = message.room;
        this.handlers.status('online');
      } else if (message.t === 'open' && Number.isInteger(message.conn)) {
        live.add(message.conn!);
        this.handlers.open(message.conn!);
      } else if (message.t === 'close' && Number.isInteger(message.conn) && live.delete(message.conn!))
        this.handlers.close(message.conn!);
    });
    socket.on('pong', () => (alive = true));
    clearInterval(this.ping);
    this.ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, PING_MS);
    let issue: string | undefined;
    socket.on('error', (error) => (issue = error.message));
    socket.on('unexpected-response', (_request, response) => (issue = `HTTP ${response.statusCode}`));
    socket.on('close', (code, reason) => {
      clearInterval(this.ping);
      for (const conn of live) this.handlers.close(conn);
      live.clear();
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;
      const replaced = code === 4409;
      if (!ready || code === 4401) this.handlers.status('error', issue || reason.toString() || '无法连接中继');
      else this.handlers.status('connecting');
      // Another copy of this computer took the room (the same data directory opened twice): back off longer.
      const wait = replaced ? 60_000 : RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
      this.timer = setTimeout(() => this.connect(), wait);
    });
  }
}
