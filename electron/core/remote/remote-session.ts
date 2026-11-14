// One phone connected through the relay. Its first frame is the plaintext hello; the reply goes back in the clear and
// everything after that travels over the encrypted channel. The hub decides what the phone may do.
import type { Channel, HelloReply, Hello } from '../../../shared/remote/crypto';
import { utf8 } from '../../../shared/remote/crypto';
import { Wire } from '../../../shared/remote/wire';
import { Paths, type DirectLink } from '../../../shared/remote/paths';
import type { RemoteEvents, ServerMessage } from '../../../shared/remote/protocol';
import type { EntityBaseline } from '../../../shared/state-sync';
import type { StoredDevice } from './remote-store';

export type SessionState = 'hello' | 'pending' | 'locked' | 'ready' | 'closed';

export interface SessionHost {
  /** Answers a hello, or rejects the phone (undefined). Sets the session's state and device. */
  accept(session: RemoteSession, hello: Hello): Promise<{ reply: HelloReply; channel: Channel } | undefined>;
  opened(session: RemoteSession): void;
  call(session: RemoteSession, method: string, params: unknown): Promise<unknown>;
  stream(session: RemoteSession, id: number, data: Uint8Array): void;
  transmit(conn: number, frame: Uint8Array): void;
  kick(conn: number): void;
  closed(session: RemoteSession): void;
}

/** The chat a phone has open: the window start and what it was last sent. */
export interface ChatSubscription {
  key: string;
  botId: string;
  sessionId?: string;
  /** The first message of the window; the window runs to the newest message. */
  startId?: string;
  hasMore: boolean;
  messages: EntityBaseline;
  runs: EntityBaseline;
  streams: string;
  permission: string;
}

/** A remote desktop connection the phone opened. */
export interface SessionStream {
  write(data: Uint8Array): void;
  close(): void;
}

const HANDSHAKE_MS = 20_000;
const decoder = new TextDecoder();

export class RemoteSession {
  state: SessionState = 'hello';
  device?: StoredDevice;
  /** A phone waiting to be allowed: its key and the name it gave itself. */
  pendingKey?: string;
  pendingName?: string;
  /** The WebAuthn challenge the phone must answer: to unlock, or to register a passkey. */
  challenge?: string;
  presence: { visible: boolean; chat?: string } = { visible: false };
  wantsHome = false;
  homeJson?: string;
  chat?: ChatSubscription;
  group?: { id: string; stamp: string };
  /** The direct connection this phone offered, if any. */
  directId?: string;
  readonly streams = new Map<number, SessionStream>();
  private nextStream = 1;
  private wire?: Wire;
  private paths?: Paths;
  private started = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    readonly conn: number,
    private readonly host: SessionHost,
  ) {
    this.timer = setTimeout(() => this.close(), HANDSHAKE_MS);
  }

  get ready() {
    return this.state === 'ready';
  }

  receive(frame: Uint8Array) {
    if (this.state === 'closed') return;
    if (this.paths) return this.paths.fromRelay(frame);
    if (this.started) return;
    this.started = true;
    void this.hello(frame);
  }

  private async hello(frame: Uint8Array) {
    try {
      const hello = JSON.parse(decoder.decode(frame)) as Hello;
      const accepted = await this.host.accept(this, hello);
      if (!accepted || this.state === 'closed') return this.close();
      const paths = new Paths(
        (data) => this.host.transmit(this.conn, data),
        (data) => wire.receive(data),
      );
      const wire = new Wire(accepted.channel, paths.send, {
        json: (value) => this.message(value),
        stream: (id, data) => this.host.stream(this, id, data),
        fail: () => this.close(),
      });
      this.wire = wire;
      this.paths = paths;
      this.host.transmit(this.conn, utf8(JSON.stringify(accepted.reply)));
      clearTimeout(this.timer);
      this.host.opened(this);
    } catch {
      this.close();
    }
  }

  /** A direct connection with the phone opened: move this side's frames onto it. */
  attachDirect(link: DirectLink) {
    if (!this.wire || !this.paths || this.state === 'closed') return link.close();
    this.paths.switchTo(this.wire, link);
  }
  receiveDirect(frame: Uint8Array) {
    this.paths?.fromDirect(frame);
  }
  /** The direct connection closed; frames may have been lost on it, so the phone connects again. */
  directClosed() {
    if (this.paths?.direct) this.close();
  }

  private message(value: unknown) {
    if ((value as { t?: string })?.t === 'switch') return this.paths?.peerSwitched();
    const call = value as { t?: string; id?: unknown; method?: unknown; params?: unknown };
    if (call?.t !== 'call' || !Number.isInteger(call.id) || typeof call.method !== 'string') return;
    const id = call.id as number;
    void this.host.call(this, call.method, call.params).then(
      (result) => this.send({ t: 'result', id, value: result }),
      (error: Error & { code?: string }) =>
        this.send({ t: 'error', id, code: error?.code || 'remote.failed', message: error?.message || String(error) }),
    );
  }

  send(message: ServerMessage) {
    if (this.state === 'closed' || !this.wire || this.wire.closed) return;
    try {
      this.wire.sendJson(message);
    } catch {
      this.close();
    }
  }
  event<K extends keyof RemoteEvents>(name: K, data: RemoteEvents[K]) {
    this.send({ t: 'event', name, data });
  }
  sendStream(id: number, data: Uint8Array) {
    if (this.state === 'closed' || !this.wire || this.wire.closed) return;
    this.wire.sendStream(id, data);
  }
  addStream(stream: SessionStream) {
    const id = this.nextStream++;
    this.streams.set(id, stream);
    return id;
  }
  closeStream(id: number) {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    stream.close();
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.timer);
    for (const id of this.streams.keys()) this.closeStream(id);
    this.paths?.close();
    this.host.kick(this.conn);
    this.host.closed(this);
  }
}
