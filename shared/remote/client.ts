// The phone's side of a connection to one computer, independent of the browser: the phone app runs it over the
// browser's WebSocket and tests over the `ws` package. It waits for the computer on the relay, shakes hands, then
// offers calls that resolve with the computer's answer, events and binary streams. It reconnects by itself.
import { startHandshake, type HelloReply } from './crypto';
import { Wire } from './wire';
import { Paths, type DirectLink } from './paths';
import {
  RELAY_CLIENT_PATH,
  relaySocketUrl,
  type RemoteMethod,
  type RemoteParams,
  type ClientMessage,
  type RemoteResult,
  type ServerMessage,
  type Welcome,
} from './protocol';
import { fromBase64Url } from './crypto';

/** What the browser's WebSocket and the `ws` package have in common. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** A computer this phone paired with. */
export interface ComputerLink {
  relay: string;
  room: string;
  /** The computer's key-agreement public key. */
  key: string;
  name: string;
}

/**
 * connecting: reaching the relay. offline: the relay is reached but the computer is not (`since` is when it was
 * last there). handshake: the computer answered. pending, locked, ready: see Welcome. rejected: the computer refused
 * this phone (unpaired or removed); the client stops. error: the relay cannot be reached; it retries.
 */
export type ClientStatus =
  'connecting' | 'offline' | 'handshake' | 'pending' | 'locked' | 'ready' | 'rejected' | 'error';

export interface ClientOptions {
  computer: ComputerLink;
  device: CryptoKeyPair;
  /** Only for the first connection: proves the QR code was scanned. */
  pairing?: { id: string; secret: Uint8Array };
  socket(url: string): SocketLike;
  onStatus(status: ClientStatus, detail?: { since?: string; reason?: string }): void;
  onWelcome?(welcome: Welcome): void;
  onEvent?(name: string, data: unknown): void;
  onStream?(id: number, data: Uint8Array): void;
}

const RETRY_MS = [500, 1000, 2000, 5000, 10_000, 20_000];
const CALL_MS = 120_000;

export class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class RemoteClient {
  status: ClientStatus = 'connecting';
  welcome?: Welcome;
  private socket?: SocketLike;
  private wire?: Wire;
  private paths?: Paths;
  private finish?: (reply: HelloReply) => Promise<void>;
  /** Frames that arrived while the reply was still being turned into a channel. */
  private early?: Uint8Array[];
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pairing?: { id: string; secret: Uint8Array };

  constructor(private readonly options: ClientOptions) {
    this.pairing = options.pairing;
  }

  connect() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    this.open();
  }

  /** Reconnects now, e.g. when the app comes back to the foreground. */
  reconnect() {
    if (this.stopped || this.status === 'rejected') return;
    if (this.status === 'ready' || this.status === 'pending' || this.status === 'locked') return;
    this.socket?.close();
    clearTimeout(this.retryTimer);
    this.retries = 0;
    this.open();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.drop(new RemoteError('remote.closed', '连接已关闭'));
    this.socket?.close();
    this.socket = undefined;
  }

  call<M extends RemoteMethod>(
    method: M,
    ...params: RemoteParams<M> extends undefined ? [] : [RemoteParams<M>]
  ): Promise<RemoteResult<M>> {
    const wire = this.wire;
    if (!wire || wire.closed) return Promise.reject(new RemoteError('remote.offline', '还没有连上电脑'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RemoteError('remote.timeout', '电脑没有回应'));
      }, CALL_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        wire.sendJson({ t: 'call', id, method, params: params[0] } satisfies ClientMessage);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  sendStream(id: number, data: Uint8Array) {
    this.wire?.sendStream(id, data);
  }

  private setStatus(status: ClientStatus, detail?: { since?: string; reason?: string }) {
    this.status = status;
    this.options.onStatus(status, detail);
  }

  private open() {
    if (this.stopped) return;
    this.setStatus('connecting');
    const url =
      relaySocketUrl(this.options.computer.relay, RELAY_CLIENT_PATH) +
      '?room=' +
      encodeURIComponent(this.options.computer.room);
    let socket: SocketLike;
    try {
      socket = this.options.socket(url);
    } catch {
      return this.retry();
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    let reached = false;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      reached = true;
      if (typeof event.data === 'string') return this.control(event.data);
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (this.paths) return this.paths.fromRelay(bytes);
      if (this.early) return void this.early.push(bytes.slice());
      if (this.finish) {
        const finish = this.finish;
        this.finish = undefined;
        this.early = [];
        void finish(JSON.parse(new TextDecoder().decode(bytes))).catch(() => socket.close());
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.drop(new RemoteError('remote.offline', '与电脑的连接断开了'));
      if (this.stopped) return;
      // The computer closed this phone before letting it in: it does not know this phone, or the user said no.
      if (event.code === 4403 && (this.status === 'handshake' || this.status === 'pending')) {
        this.stopped = true;
        return this.setStatus('rejected', { reason: event.reason });
      }
      if (!reached) this.setStatus('error', { reason: event.reason });
      this.retry();
    };
    socket.onerror = () => {};
  }

  private retry() {
    if (this.stopped) return;
    const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => this.open(), wait);
  }

  private control(text: string) {
    let message: { t?: string; since?: string };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.t === 'offline') {
      this.drop(new RemoteError('remote.offline', '电脑不在线'));
      this.setStatus('offline', message.since ? { since: message.since } : undefined);
    } else if (message.t === 'online') {
      this.drop(new RemoteError('remote.offline', '电脑重新连接了'));
      void this.handshake();
    }
  }

  private async handshake() {
    const socket = this.socket;
    if (!socket) return;
    this.setStatus('handshake');
    const started = await startHandshake({
      device: this.options.device,
      desktopKey: fromBase64Url(this.options.computer.key),
      pairing: this.pairing,
    });
    if (this.socket !== socket) return;
    this.finish = async (reply) => {
      const channel = await started.finish(reply);
      if (this.socket !== socket) return;
      const paths = new Paths(
        (frame) => socket.send(frame),
        (frame) => wire.receive(frame),
      );
      const wire = new Wire(channel, paths.send, {
        json: (value) => this.message(value as ServerMessage),
        stream: (id, data) => this.options.onStream?.(id, data),
        fail: () => socket.close(),
      });
      this.wire = wire;
      this.paths = paths;
      const early = this.early || [];
      this.early = undefined;
      for (const frame of early) paths.fromRelay(frame);
    };
    socket.send(new TextEncoder().encode(JSON.stringify(started.hello)));
  }

  /** Whether frames already travel over a direct connection. */
  get direct() {
    return Boolean(this.paths?.direct);
  }

  /** A direct connection to the computer opened: move this side's frames onto it. */
  attachDirect(link: DirectLink) {
    if (!this.wire || !this.paths) return link.close();
    this.paths.switchTo(this.wire, link);
  }
  receiveDirect(frame: Uint8Array) {
    this.paths?.fromDirect(frame);
  }
  /** The direct connection closed. Once frames used it, they may be lost: start over through the relay. */
  directClosed() {
    if (this.paths?.direct) this.socket?.close();
  }

  private message(message: ServerMessage) {
    if (message.t === 'switch') return this.paths?.peerSwitched();
    if (message.t === 'welcome') {
      this.welcome = message;
      this.retries = 0;
      // A paired phone proves itself with its key from now on.
      if (message.state !== 'pending') this.pairing = undefined;
      this.options.onWelcome?.(message);
      this.setStatus(message.state);
      return;
    }
    if (message.t === 'event') {
      if (message.name === 'state') {
        const data = message.data as Pick<Welcome, 'state' | 'device'>;
        if (this.welcome) this.welcome = { ...this.welcome, ...data };
        if (data.state !== 'pending') this.pairing = undefined;
        this.setStatus(data.state);
      }
      this.options.onEvent?.(message.name, message.data);
      return;
    }
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.t === 'result') call.resolve(message.value);
    else call.reject(new RemoteError(message.code, message.message));
  }

  /** Forgets the channel; calls in flight fail with `error`. */
  private drop(error: Error) {
    this.paths?.close();
    this.paths = undefined;
    this.wire = undefined;
    this.finish = undefined;
    this.early = undefined;
    this.welcome = undefined;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }
}
