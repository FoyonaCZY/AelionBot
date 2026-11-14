// The phone app's link to the selected computer, as a store React reads with useSyncExternalStore: connection
// status, the welcome, the home list, messages queued while offline. Screens call methods and listen to events
// through it; it reconnects when the app returns to the foreground or the network comes back.
import { useSyncExternalStore } from 'react';
import { RemoteClient, RemoteError, type ClientStatus, type SocketLike } from '../../shared/remote/client';
import { fromBase64Url } from '../../shared/remote/crypto';
import type {
  HomeView,
  PairingLink,
  RemoteMethod,
  RemoteParams,
  RemoteResult,
  Welcome,
} from '../../shared/remote/protocol';
import { translate } from '../../shared/i18n';
import * as storage from './storage';
import { tryDirect } from './direct';
import type { QueuedMessage, StoredComputer } from './storage';

interface ConnectionState {
  /** Storage was read; until then the app shows nothing. */
  loaded: boolean;
  computers: StoredComputer[];
  computer?: StoredComputer;
  status: ClientStatus | 'none';
  /** While offline: when the computer was last connected. */
  since?: string;
  welcome?: Welcome;
  home?: HomeView;
  queue: QueuedMessage[];
}

/** A name for this phone, shown on the computer until the user renames it. */
function deviceName() {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad|Macintosh.*Mobile/.test(agent)) return 'iPad';
  if (/Android/.test(agent)) return translate('Android 手机');
  return translate('浏览器');
}

const DIRECT_BACKOFF_MS = 10 * 60_000;

class Connection {
  state: ConnectionState = { loaded: false, computers: [], status: 'none', queue: [] };
  private readonly listeners = new Set<() => void>();
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  private readonly streamHandlers = new Map<number, (data: Uint8Array) => void>();
  private client?: RemoteClient;
  private device?: CryptoKeyPair;
  private chat?: string;
  private flushing = false;
  private directBrokeAt = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  private set(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async init() {
    const computers = await storage.loadComputers(),
      current = await storage.loadCurrent();
    this.device = await storage.deviceKey();
    this.set({ loaded: true, computers });
    const computer = computers.find((item) => item.room === current) || computers[0];
    if (computer) await this.select(computer.room);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.client?.reconnect();
      this.presence();
    });
    window.addEventListener('online', () => this.client?.reconnect());
  }

  async select(room: string) {
    this.client?.close();
    this.client = undefined;
    const computer = this.state.computers.find((item) => item.room === room);
    await storage.saveCurrent(computer?.room);
    if (!computer)
      return this.set({ computer: undefined, status: 'none', welcome: undefined, home: undefined, queue: [] });
    this.set({
      computer,
      status: 'connecting',
      since: undefined,
      welcome: undefined,
      home: undefined,
      queue: await storage.loadQueue(room),
    });
    const client: RemoteClient = new RemoteClient({
      computer,
      device: this.device!,
      pairing: computer.pairing
        ? { id: computer.pairing.id, secret: fromBase64Url(computer.pairing.secret) }
        : undefined,
      socket: (url) => new WebSocket(url) as unknown as SocketLike,
      onStatus: (status, detail) => void this.status(client, status, detail?.since),
      onWelcome: (welcome) => this.client === client && this.set({ welcome }),
      onEvent: (name, data) => this.client === client && this.event(name, data),
      onStream: (id, data) => this.streamHandlers.get(id)?.(data),
    });
    this.client = client;
    client.connect();
  }

  private async status(client: RemoteClient, status: ClientStatus, since?: string) {
    if (client !== this.client) return;
    this.set({ status, since: status === 'offline' ? since || this.state.since : this.state.since });
    if (status === 'pending') void this.call('device.update', { name: deviceName() }).catch(() => {});
    if (status !== 'ready') return;
    const computer = this.state.computer;
    if (computer?.pairing) {
      // Allowed: from now on the phone's key is enough.
      const computers = this.state.computers.map((item) =>
        item.room === computer.room ? { ...item, pairing: undefined } : item,
      );
      await storage.saveComputers(computers);
      this.set({ computers, computer: computers.find((item) => item.room === computer.room) });
      // Paired from the pairing screen: show the Bots.
      if (location.hash.startsWith('#/pair')) location.replace('#/');
    }
    this.set({ welcome: client.welcome, since: undefined });
    try {
      this.set({ home: await this.call('home.subscribe') });
    } catch {
      return;
    }
    this.presence();
    this.emit('ready', undefined);
    void this.flush();
    // A direct connection that broke recently is not tried again for a while: it would only bounce.
    if (
      client.welcome?.capabilities.includes('direct') &&
      !client.direct &&
      Date.now() - this.directBrokeAt > DIRECT_BACKOFF_MS
    )
      void tryDirect({
        client,
        relay: this.state.computer!.relay,
        broke: () => (this.directBrokeAt = Date.now()),
        call: (method, params) => client.call(method, ...([params] as never)),
        onCandidate: (handler) => this.on('direct.candidate', (data) => handler(data as RTCIceCandidateInit)),
      }).catch(() => {});
  }

  private event(name: string, data: unknown) {
    if (name === 'home') this.set({ home: data as HomeView });
    if (name === 'state') this.set({ welcome: this.client?.welcome });
    if (name === 'stream.close') this.streamHandlers.delete((data as { stream: number }).stream);
    this.emit(name, data);
  }
  private emit(name: string, data: unknown) {
    for (const handler of this.handlers.get(name) || []) handler(data);
  }

  /** Listens to an event the computer pushes, or to 'ready' (the connection came up). */
  on(name: string, handler: (data: unknown) => void) {
    const set = this.handlers.get(name) || new Set();
    set.add(handler);
    this.handlers.set(name, set);
    return () => set.delete(handler);
  }
  onStream(id: number, handler: (data: Uint8Array) => void) {
    this.streamHandlers.set(id, handler);
    return () => this.streamHandlers.delete(id);
  }
  sendStream(id: number, data: Uint8Array) {
    this.client?.sendStream(id, data);
  }

  call<M extends RemoteMethod>(
    method: M,
    ...params: RemoteParams<M> extends undefined ? [] : [RemoteParams<M>]
  ): Promise<RemoteResult<M>> {
    if (!this.client) return Promise.reject(new RemoteError('remote.offline', translate('还没有连上电脑')));
    return this.client.call(method, ...params);
  }

  /** The chat on screen, so the computer skips notifications the user is already looking at. */
  presence(chat?: string | null) {
    if (chat !== undefined) this.chat = chat || undefined;
    if (this.state.status !== 'ready') return;
    void this.call('presence', {
      visible: document.visibilityState === 'visible',
      ...(this.chat ? { chat: this.chat } : {}),
    }).catch(() => {});
  }

  async addComputer(link: PairingLink) {
    const computer: StoredComputer = {
      relay: link.u,
      room: link.r,
      key: link.k,
      name: link.n,
      addedAt: new Date().toISOString(),
      pairing: { id: link.i, secret: link.s },
    };
    const computers = [...this.state.computers.filter((item) => item.room !== link.r), computer];
    await storage.saveComputers(computers);
    this.set({ computers });
    await this.select(computer.room);
  }

  /** Forgets a computer here, and tells it to forget this phone when it can. */
  async removeComputer(room: string) {
    if (room === this.state.computer?.room && this.state.status === 'ready')
      await this.call('device.forget').catch(() => {});
    const computers = this.state.computers.filter((item) => item.room !== room);
    await storage.saveComputers(computers);
    await storage.saveQueue(room, []);
    this.set({ computers });
    if (room === this.state.computer?.room) await this.select(computers[0]?.room || '');
  }

  // ---------- Messages written while the computer is away ----------

  async enqueue(message: Omit<QueuedMessage, 'id' | 'createdAt'>) {
    const room = this.state.computer?.room;
    if (!room) return;
    const queue = [...this.state.queue, { ...message, id: crypto.randomUUID(), createdAt: new Date().toISOString() }];
    await storage.saveQueue(room, queue);
    this.set({ queue });
  }
  async dequeue(id: string) {
    const room = this.state.computer?.room;
    if (!room) return;
    const queue = this.state.queue.filter((item) => item.id !== id);
    await storage.saveQueue(room, queue);
    this.set({ queue });
  }
  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const item of this.state.queue) {
        if (this.state.status !== 'ready') break;
        try {
          await this.call('chat.send', {
            botId: item.botId,
            ...(item.sessionId ? { sessionId: item.sessionId } : {}),
            message: item.text,
          });
        } catch (error) {
          // Offline again: keep it. Refused (the Bot is gone…): drop it, it would never go.
          if ((error as RemoteError).code === 'remote.offline' || (error as RemoteError).code === 'remote.timeout')
            break;
        }
        await this.dequeue(item.id);
      }
    } finally {
      this.flushing = false;
    }
  }
}

export const connection = new Connection();
export function useConnection() {
  return useSyncExternalStore(connection.subscribe, connection.snapshot);
}
