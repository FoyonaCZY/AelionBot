// Phone access: this computer keeps a connection to the relay, pairs phones by QR code, and serves each connected
// phone what it asks for: the home list, one open chat, a group, files, speech, the work computer's screen. Actions
// go through the same handlers as the app's own window, behind a stricter allowlist (see `call`). It also sends Web
// Push notifications when a Bot needs the user or finishes while nobody is at the computer.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { renderSVG } from 'uqr';
import { AppError } from '../../../shared/errors';
import { translate } from '../../../shared/i18n';
import { acceptHandshake, randomBytes, toBase64Url, type Bytes, type Hello } from '../../../shared/remote/crypto';
import {
  chatKey,
  DEFAULT_NOTIFY,
  normalizeRelayUrl,
  OFFICIAL_APP_URL,
  OFFICIAL_RELAY_URL,
  pairingUrl,
  REMOTE_CAPABILITIES,
  REMOTE_FILE_BYTES,
  REMOTE_PROTOCOL,
  type ChatDelta,
  type ChatView,
  type HomeView,
  type NotifyPrefs,
  type PushPayload,
  type Welcome,
} from '../../../shared/remote/protocol';
import { diffEntities, emptyBaseline } from '../../../shared/state-sync';
import type { IpcMethod } from '../../../shared/ipc';
import type { Attachment, AttachmentScope, AttachmentUpload } from '../../../shared/types/attachment-types';
import type {
  ComputerDesktopState,
  ComputerState,
  InteractionAction,
  InteractionRequest,
  StreamingReply,
} from '../../../shared/types/core';
import type { GroupPage, GroupsView } from '../../../shared/types/group-types';
import type { HostPermissionMode } from '../../../shared/types/permission-types';
import type { RemoteSettingsInput, RemoteView } from '../../../shared/types/remote-types';
import { readableContent } from '../../../shared/chat/activity';
import type { SecretCodec } from '../connectors/connector-store';
import type { Store } from '../storage/store';
import { RelayLink } from './relay-link';
import { RemoteSession, type SessionHost } from './remote-session';
import { RemoteStore, type RemoteKeys, type StoredDevice } from './remote-store';
import {
  chatMessages,
  chatStreams,
  forgetTrimmed,
  homeView,
  previewText,
  recentFiles,
  trimMessage,
  windowRuns,
  windowStart,
  WINDOW_TURNS,
} from './remote-view';
import { sendPush } from './web-push';
import { stunFor, type DirectPeers } from './direct';
import { verifyAssertion, verifyRegistration } from './webauthn';

export interface RemoteDeps {
  store: Store;
  dataDir: string;
  codec: SecretCodec;
  version: string;
  /** Runs the handler the app's window reaches through IPC, with the same checks. */
  call(method: IpcMethod, ...args: unknown[]): Promise<unknown>;
  streams(): StreamingReply[];
  interactions(): InteractionRequest[];
  computer: { readonly state: ComputerState; stateFor(botId: string): ComputerDesktopState };
  vmStatus(): string;
  groups(): GroupsView | undefined;
  speech(): { input: boolean; output: boolean };
  attachments: { bytes(id: string): Buffer; metadata(id: string): { name: string; mime: string; size: number } };
  permissionMode(scope: AttachmentScope): HostPermissionMode;
  /** Seconds since the last keyboard or mouse input on this computer. */
  idleSeconds(): number;
  keepAwake(on: boolean): void;
  /** The settings view changed; refresh the window. */
  changed(): void;
  fetch?: typeof fetch;
  /** Opens a socket to a desktop's VNC bridge (tests replace it). */
  connectDesktop?(url: string): WebSocket;
  /** Direct connections with phones on the same network; without it phones stay on the relay. */
  direct?: DirectPeers;
}

interface Pairing {
  id: string;
  secret: Bytes;
  expiresAt: number;
  url: string;
  qrSvg: string;
  /** A phone that proved the secret, waiting for the user to allow it. */
  request?: RemoteSession;
}

const PAIRING_MS = 10 * 60_000;
const TICK_MS = 300;
const STREAM_TICK_MS = 250;
/** Someone used this computer this recently: finished tasks are not pushed to the phone. */
const PRESENT_SECONDS = 120;
const PUSH_REPEAT_MS = 10_000;

const fail = (code: string, message: string): never => {
  throw new AppError(code, message);
};
const text = (value: unknown, max: number, name = '参数') => {
  if (typeof value !== 'string' || value.length > max) fail('remote.invalid', `${name}无效`);
  return value as string;
};
const optionalText = (value: unknown, max: number) => (value === undefined ? undefined : text(value, max));
const object = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const ids = (value: unknown) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10 || value.some((item) => typeof item !== 'string'))
    fail('remote.invalid', '附件无效');
  return value as string[];
};

export class RemoteHub implements SessionHost {
  readonly store: RemoteStore;
  private link?: RelayLink;
  private status: RemoteView['status'] = 'off';
  private issue?: string;
  private keys?: RemoteKeys;
  private readonly sessions = new Map<number, RemoteSession>();
  private pairing?: Pairing;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private streamTimer?: ReturnType<typeof setTimeout>;
  private lastTick = 0;
  private lastStreams = 0;
  /** What notifications were last decided against: requests seen and runs that were running. */
  private seenRequests?: Set<string>;
  private runningRuns?: Set<string>;
  private readonly pushedAt = new Map<string, number>();

  constructor(private readonly deps: RemoteDeps) {
    this.store = new RemoteStore(deps.dataDir, deps.codec);
  }

  get enabled() {
    return this.store.data.enabled;
  }
  get relayUrl() {
    return this.store.data.relayUrl || OFFICIAL_RELAY_URL;
  }
  /** A self-hosted relay serves the phone app too, unless another address was set for it. */
  get appUrl() {
    return this.store.data.appUrl || this.store.data.relayUrl || OFFICIAL_APP_URL;
  }

  start() {
    if (this.enabled) void this.connect();
  }

  stop() {
    this.link?.stop();
    this.link = undefined;
    for (const session of this.sessions.values()) session.close();
    this.pairing = undefined;
    this.status = 'off';
    this.issue = undefined;
    clearTimeout(this.tickTimer);
    clearTimeout(this.streamTimer);
    this.deps.keepAwake(false);
  }

  /** The computer woke up or the network changed: reconnect now instead of waiting for the next retry. */
  wake() {
    this.link?.reconnect();
  }

  private async connect() {
    this.link?.stop();
    this.status = 'connecting';
    this.issue = undefined;
    this.deps.changed();
    try {
      this.keys = await this.store.loadKeys();
    } catch (error) {
      this.status = 'error';
      this.issue = (error as Error).message;
      this.deps.changed();
      return;
    }
    if (!this.enabled) return;
    const link = new RelayLink(
      this.relayUrl,
      { publicKey: this.keys.signingPublic, privateKey: this.keys.signing.privateKey },
      {
        open: (conn) => this.sessions.set(conn, new RemoteSession(conn, this)),
        close: (conn) => this.sessions.get(conn)?.close(),
        frame: (conn, data) => this.sessions.get(conn)?.receive(data),
        status: (status, issue) => {
          this.status = status;
          this.issue = issue;
          this.deps.changed();
        },
      },
    );
    this.link = link;
    link.start();
    this.deps.keepAwake(this.store.data.keepAwake);
  }

  async update(input: RemoteSettingsInput) {
    const data = this.store.data;
    let reconnect = false;
    if (input.relayUrl !== undefined) {
      const url = normalizeRelayUrl(text(input.relayUrl, 300, '中继地址'));
      const next = url === OFFICIAL_RELAY_URL ? undefined : url || undefined;
      if (next !== data.relayUrl) {
        data.relayUrl = next;
        reconnect = true;
      }
      if (!next) delete data.relayUrl;
    }
    if (input.appUrl !== undefined) {
      const url = normalizeRelayUrl(text(input.appUrl, 300, '手机网页地址'));
      if (url && url !== OFFICIAL_APP_URL) data.appUrl = url;
      else delete data.appUrl;
    }
    if (input.name !== undefined) {
      const name = text(input.name, 60, '电脑名称').trim();
      if (name) data.name = name;
      else delete data.name;
    }
    if (input.keepAwake !== undefined) {
      data.keepAwake = Boolean(input.keepAwake);
      if (this.enabled) this.deps.keepAwake(data.keepAwake);
    }
    const enabling = input.enabled !== undefined && Boolean(input.enabled) !== data.enabled;
    if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
    this.store.save();
    if (enabling || reconnect) {
      if (data.enabled) {
        this.stop();
        await this.connect();
      } else this.stop();
    } else if (input.name !== undefined) for (const session of this.sessions.values()) session.homeJson = undefined;
    this.pairing = reconnect ? undefined : this.pairing;
    this.deps.changed();
    this.changed();
  }

  view(): RemoteView {
    const data = this.store.data;
    return {
      enabled: data.enabled,
      relayUrl: this.relayUrl,
      appUrl: this.appUrl,
      customRelayUrl: data.relayUrl || '',
      customAppUrl: data.appUrl || '',
      status: data.enabled ? this.status : 'off',
      ...(data.enabled && this.issue ? { issue: this.issue } : {}),
      name: this.store.name,
      keepAwake: data.keepAwake,
      devices: data.devices.map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
        online: [...this.sessions.values()].some((session) => session.ready && session.device?.id === device.id),
        push: Boolean(device.push),
        verify: Boolean(device.verify),
      })),
      ...(this.pairing && this.pairing.expiresAt > Date.now()
        ? {
            pairing: {
              url: this.pairing.url,
              qrSvg: this.pairing.qrSvg,
              expiresAt: new Date(this.pairing.expiresAt).toISOString(),
              ...(this.pairing.request
                ? { request: { name: this.pairing.request.pendingName || translate('手机') } }
                : {}),
            },
          }
        : {}),
    };
  }

  // ---------- Pairing and devices ----------

  async startPairing() {
    if (!this.enabled) fail('remote.disabled', '请先打开手机访问');
    const keys = (this.keys ??= await this.store.loadKeys());
    if (!this.link?.room) fail('remote.offline', '还没有连上中继，请稍后再试');
    this.pairing?.request?.close();
    const id = toBase64Url(randomBytes(9)),
      secret = randomBytes(32);
    const url = pairingUrl(this.appUrl, {
      v: REMOTE_PROTOCOL,
      u: this.relayUrl,
      r: this.link!.room!,
      k: toBase64Url(keys.agreementPublic),
      i: id,
      s: toBase64Url(secret),
      n: this.store.name,
    });
    this.pairing = { id, secret, expiresAt: Date.now() + PAIRING_MS, url, qrSvg: renderSVG(url, { border: 2 }) };
    this.deps.changed();
  }

  cancelPairing() {
    this.pairing?.request?.close();
    this.pairing = undefined;
    this.deps.changed();
  }

  decidePairing(allow: boolean) {
    const pairing = this.pairing,
      session = pairing?.request;
    if (!pairing || !session || session.state !== 'pending') fail('remote.no_request', '没有等待确认的手机');
    this.pairing = undefined;
    if (!allow) {
      session!.close();
      this.deps.changed();
      return;
    }
    const key = session!.pendingKey!;
    const device: StoredDevice = {
      id: randomUUID(),
      name: (session!.pendingName || translate('手机')).slice(0, 60),
      key,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      notify: { ...DEFAULT_NOTIFY },
    };
    this.store.data.devices.push(device);
    this.store.save();
    session!.device = device;
    session!.state = 'ready';
    session!.event('state', { state: 'ready', device: this.deviceInfo(device) });
    this.deps.changed();
  }

  removeDevice(id: string) {
    const index = this.store.data.devices.findIndex((device) => device.id === id);
    if (index < 0) fail('remote.no_device', '这台手机已经移除');
    this.store.data.devices.splice(index, 1);
    this.store.save();
    for (const session of this.sessions.values()) if (session.device?.id === id) session.close();
    this.deps.changed();
  }

  private deviceInfo(device: StoredDevice): Welcome['device'] {
    return {
      id: device.id,
      name: device.name,
      notify: device.notify,
      push: Boolean(device.push),
      verify: Boolean(device.verify),
    };
  }

  // ---------- Sessions (SessionHost) ----------

  async accept(session: RemoteSession, hello: Hello) {
    const keys = (this.keys ??= await this.store.loadKeys());
    const pairing = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : undefined;
    const accepted = await acceptHandshake({
      desktop: keys.agreement,
      desktopPublic: keys.agreementPublic,
      hello,
      pairingSecret: (id) => (pairing && !pairing.request && id === pairing.id ? pairing.secret : undefined),
    });
    const device = this.store.deviceByKey(accepted.phoneKey);
    if (device) {
      session.device = device;
      session.state = device.verify ? 'locked' : 'ready';
    } else if (accepted.paired && pairing) {
      session.state = 'pending';
      session.pendingKey = accepted.phoneKey;
      pairing.request = session;
      this.deps.changed();
    } else return;
    return { reply: accepted.reply, channel: accepted.channel };
  }

  opened(session: RemoteSession) {
    const device = session.device;
    if (device) {
      device.lastSeenAt = new Date().toISOString();
      this.store.save();
    }
    if (session.state === 'locked') session.challenge = toBase64Url(randomBytes(32));
    session.send({
      t: 'welcome',
      protocol: REMOTE_PROTOCOL,
      app: this.deps.version,
      name: this.store.name,
      capabilities: REMOTE_CAPABILITIES.filter((item) => item !== 'direct' || this.deps.direct),
      device: device
        ? this.deviceInfo(device)
        : { id: '', name: session.pendingName || '', notify: DEFAULT_NOTIFY, push: false, verify: false },
      state: session.state as Welcome['state'],
      ...(session.state === 'locked' && device?.verify
        ? {
            verify: {
              challenge: session.challenge!,
              credentialId: device.verify.credentialId,
              rpId: device.verify.rpId,
            },
          }
        : {}),
    });
    this.deps.changed();
  }

  transmit(conn: number, frame: Uint8Array) {
    this.link?.send(conn, frame);
  }
  kick(conn: number) {
    this.link?.kick(conn);
  }
  closed(session: RemoteSession) {
    this.sessions.delete(session.conn);
    if (session.directId) this.deps.direct?.close(session.directId);
    if (this.pairing?.request === session) this.pairing.request = undefined;
    if (session.device) {
      session.device.lastSeenAt = new Date().toISOString();
      this.store.save();
    }
    this.deps.changed();
  }
  stream(session: RemoteSession, id: number, data: Uint8Array) {
    if (session.ready) session.streams.get(id)?.write(data);
  }

  async call(session: RemoteSession, method: string, params: unknown): Promise<unknown> {
    const input = object(params);
    if (session.state === 'pending') {
      if (method !== 'device.update') fail('remote.pending', '请先在电脑上允许这台手机');
      session.pendingName = text(input.name, 60, '名称').trim() || undefined;
      this.deps.changed();
      return;
    }
    if (session.state === 'locked') {
      if (method !== 'verify.unlock') fail('remote.locked', '请先完成身份验证');
      return this.unlock(session, input);
    }
    if (!session.ready) fail('remote.closed', '连接已断开');
    const device = session.device!;
    const { call } = this.deps;
    switch (method) {
      case 'home.subscribe':
        session.wantsHome = true;
        return this.homeFor(session);
      case 'chat.open':
        return this.openChat(session, text(input.botId, 100), optionalText(input.sessionId, 100));
      case 'chat.more':
        return this.moreChat(session, text(input.key, 220));
      case 'chat.close':
        session.chat = undefined;
        return;
      case 'chat.send':
        return call('send', {
          botId: text(input.botId, 100),
          ...(input.sessionId ? { sessionId: text(input.sessionId, 100) } : {}),
          message: text(input.message, 60_000, '消息'),
          ...(input.attachmentIds ? { attachmentIds: ids(input.attachmentIds) } : {}),
          ...(input.replyToMessageId ? { replyToMessageId: text(input.replyToMessageId, 100) } : {}),
        });
      case 'chat.stop':
        return call('cancel', text(input.botId, 100), optionalText(input.sessionId, 100));
      case 'chat.retract':
        return call('retractChat', {
          botId: text(input.botId, 100),
          ...(input.sessionId ? { sessionId: text(input.sessionId, 100) } : {}),
          messageId: text(input.messageId, 100),
        });
      case 'chat.resume':
        return call('resumeChat', { botId: text(input.botId, 100), runId: text(input.runId, 100) });
      case 'chat.toolResult':
        return call('readToolResult', { botId: text(input.botId, 100), messageId: text(input.messageId, 100) });
      case 'session.create':
        return call('createWorkSession', { botId: text(input.botId, 100), name: text(input.name, 80, '名称') });
      case 'session.update':
        return call('updateWorkSession', {
          id: text(input.id, 100),
          ...(input.name !== undefined ? { name: text(input.name, 80, '名称') } : {}),
          ...(input.archived !== undefined ? { archived: Boolean(input.archived) } : {}),
        });
      case 'permission.set': {
        // The phone cannot turn every check off: full access is chosen at the computer only.
        const mode = input.mode;
        if (mode !== 'ask' && mode !== 'auto') fail('remote.forbidden', '手机上只能选择“每次询问”或“自动审批”');
        return call('setHostPermissionMode', {
          scope: {
            kind: 'bot',
            id: text(input.botId, 100),
            ...(input.sessionId ? { sessionId: text(input.sessionId, 100) } : {}),
          },
          mode,
        });
      }
      case 'request.respond': {
        const action = input.action as InteractionAction;
        if (!['allow', 'allow-always', 'deny', 'takeover', 'resume', 'cancel', 'answer'].includes(action))
          fail('remote.invalid', '无效操作');
        const answers = input.answers === undefined ? undefined : object(input.answers);
        if (answers && Object.values(answers).some((value) => typeof value !== 'string' || value.length > 4000))
          fail('remote.invalid', '回答无效');
        return call('respondInteraction', {
          id: text(input.id, 100),
          action,
          ...(answers ? { answers: answers as Record<string, string> } : {}),
        });
      }
      case 'files.upload': {
        const scope = object(input.scope),
          bytes = input.bytes;
        if (!(bytes instanceof Uint8Array) || !bytes.length) fail('remote.invalid', '文件为空');
        if ((bytes as Uint8Array).length > REMOTE_FILE_BYTES) fail('remote.too_large', '文件不能超过 25 MB');
        const kind = scope.kind === 'group' ? 'group' : 'bot';
        const files: AttachmentUpload[] = [{ name: text(input.name, 255, '文件名'), bytes: bytes as Uint8Array }];
        const result = (await call('importAttachments', {
          scope: {
            kind,
            id: text(scope.id, 100),
            ...(kind === 'bot' && scope.sessionId ? { sessionId: text(scope.sessionId, 100) } : {}),
          },
          files,
        })) as Attachment[];
        return result[0];
      }
      case 'files.read': {
        const id = text(input.id, 100),
          meta = this.deps.attachments.metadata(id);
        if (meta.size > REMOTE_FILE_BYTES) fail('remote.too_large', '文件超过 25 MB，请在电脑上查看');
        return { name: meta.name, mime: meta.mime, bytes: new Uint8Array(this.deps.attachments.bytes(id)) };
      }
      case 'files.recent':
        return recentFiles(this.deps.store, text(input.botId, 100));
      case 'speech.transcribe': {
        if (!(input.audio instanceof Uint8Array) || input.audio.length > REMOTE_FILE_BYTES)
          fail('remote.invalid', '录音无效');
        return call('transcribeSpeech', { audio: input.audio, ...(input.name ? { name: text(input.name, 100) } : {}) });
      }
      case 'speech.synthesize':
        return call('synthesizeSpeech', {
          text: text(input.text, 20_000, '文字'),
          ...(input.botId ? { botId: text(input.botId, 100) } : {}),
        });
      case 'automation.run':
        return call('runScheduledTask', text(input.id, 100));
      case 'automation.setEnabled': {
        const id = text(input.id, 100),
          task = this.deps.store.data.scheduledTasks?.find((item) => item.id === id);
        if (!task) fail('remote.no_task', '自动化不存在');
        // A script a Bot wrote is turned on only after the user has read it, at the computer.
        if (input.enabled && task!.needsReview) fail('remote.review', '这个自动化需要先在电脑上查看后才能启用');
        return call('updateScheduledTask', { id, status: input.enabled ? 'enabled' : 'paused' });
      }
      case 'group.open': {
        const id = text(input.id, 100);
        const page = await call('readGroup', { id });
        session.group = { id, stamp: this.groupStamp(id) };
        return page;
      }
      case 'group.more':
        return call('readGroup', { id: text(input.id, 100), before: text(input.before, 100) });
      case 'group.close':
        session.group = undefined;
        return;
      case 'group.send':
        return call('sendGroup', {
          id: text(input.id, 100),
          message: text(input.message, 60_000, '消息'),
          ...(input.attachmentIds ? { attachmentIds: ids(input.attachmentIds) } : {}),
          ...(input.replyToMessageId ? { replyToMessageId: text(input.replyToMessageId, 100) } : {}),
        });
      case 'group.read': {
        if (!Number.isInteger(input.seq)) fail('remote.invalid', '参数无效');
        return call('markGroupRead', { id: text(input.id, 100), seq: input.seq });
      }
      case 'group.stop':
        return call('stopGroup', text(input.id, 100));
      case 'computer.open':
        return this.openComputer(session, text(input.botId, 100));
      case 'computer.close': {
        if (!Number.isInteger(input.stream)) fail('remote.invalid', '参数无效');
        session.closeStream(input.stream as number);
        return;
      }
      case 'computer.control':
        return call('setComputerControl', { botId: text(input.botId, 100), enabled: Boolean(input.enabled) });
      case 'push.key':
        return { key: toBase64Url((this.keys ??= await this.store.loadKeys()).vapidPublic) };
      case 'push.subscribe': {
        const endpoint = text(input.endpoint, 1000, '推送地址'),
          keys = object(input.keys);
        if (new URL(endpoint).protocol !== 'https:') fail('remote.invalid', '推送地址无效');
        this.store.setPushSubscription(device, {
          endpoint,
          keys: { p256dh: text(keys.p256dh, 200), auth: text(keys.auth, 100) },
        });
        this.store.save();
        this.deps.changed();
        return;
      }
      case 'push.unsubscribe':
        this.store.setPushSubscription(device, undefined);
        this.store.save();
        this.deps.changed();
        return;
      case 'push.test':
        if (
          !(await this.push(device, { title: this.store.name, body: translate('通知已开启'), tag: 'test', url: '/' }))
        )
          fail('remote.push_failed', '推送没有送达，请重新开启通知');
        return;
      case 'device.update': {
        if (input.name !== undefined) {
          const name = text(input.name, 60, '名称').trim();
          if (name) device.name = name;
        }
        if (input.notify !== undefined) {
          const notify = object(input.notify);
          for (const key of Object.keys(DEFAULT_NOTIFY) as Array<keyof NotifyPrefs>)
            if (typeof notify[key] === 'boolean') device.notify[key] = notify[key] as boolean;
        }
        this.store.save();
        this.deps.changed();
        return this.deviceInfo(device);
      }
      case 'device.forget':
        this.removeDevice(device.id);
        return;
      case 'presence':
        session.presence = { visible: Boolean(input.visible), ...(input.chat ? { chat: text(input.chat, 220) } : {}) };
        return;
      case 'verify.begin':
        session.challenge = toBase64Url(randomBytes(32));
        return {
          challenge: session.challenge,
          rpId: new URL(this.appUrl).hostname,
          userId: toBase64Url(new TextEncoder().encode(device.id)),
          userName: device.name,
        };
      case 'verify.register': {
        if (!session.challenge) fail('remote.verify', '验证已过期，请重试');
        device.verify = verifyRegistration({
          clientData: text(input.clientData, 4000),
          challenge: session.challenge!,
          credentialId: text(input.credentialId, 1000),
          publicKey: text(input.publicKey, 1000),
          rpId: text(input.rpId, 255),
        });
        session.challenge = undefined;
        this.store.save();
        this.deps.changed();
        return this.deviceInfo(device);
      }
      case 'direct.offer': {
        const peers = this.deps.direct;
        if (!peers) return fail('remote.unsupported', '这台电脑不支持直连');
        if (session.directId) peers.close(session.directId);
        const id = `${session.conn}-${toBase64Url(randomBytes(6))}`;
        session.directId = id;
        const sdp = await peers.answer(id, text(input.sdp, 20_000), stunFor(this.relayUrl), {
          candidate: (candidate) => session.event('direct.candidate', candidate),
          open: () => session.attachDirect({ send: (data) => peers.send(id, data), close: () => peers.close(id) }),
          frame: (data) => session.receiveDirect(data),
          close: () => session.directClosed(),
        });
        return { sdp };
      }
      case 'direct.candidate': {
        if (!this.deps.direct || !session.directId) return;
        this.deps.direct.candidate(session.directId, {
          candidate: text(input.candidate, 2000),
          ...(typeof input.sdpMid === 'string' ? { sdpMid: input.sdpMid } : {}),
          ...(Number.isInteger(input.sdpMLineIndex) ? { sdpMLineIndex: input.sdpMLineIndex as number } : {}),
        });
        return;
      }
      case 'verify.disable':
        delete device.verify;
        this.store.save();
        this.deps.changed();
        return this.deviceInfo(device);
      default:
        return fail('remote.forbidden', '手机上不能执行这个操作');
    }
  }

  private unlock(session: RemoteSession, input: Record<string, unknown>) {
    const device = session.device!;
    if (!device.verify || !session.challenge) fail('remote.verify', '验证已过期，请重新连接');
    device.verify!.counter = verifyAssertion({
      authenticatorData: text(input.authenticatorData, 4000),
      clientData: text(input.clientData, 4000),
      signature: text(input.signature, 1000),
      challenge: session.challenge!,
      stored: device.verify!,
    });
    session.challenge = undefined;
    session.state = 'ready';
    this.store.save();
    session.event('state', { state: 'ready', device: this.deviceInfo(device) });
    this.deps.changed();
  }

  // ---------- Views ----------

  private home?: { view: HomeView; json: string; at: number };
  private homeNow() {
    if (this.home && Date.now() - this.home.at < TICK_MS / 2) return this.home;
    const view = homeView({
      store: this.deps.store,
      name: this.store.name,
      streams: this.deps.streams(),
      interactions: this.deps.interactions(),
      computer: this.deps.computer.state,
      vmStatus: this.deps.vmStatus(),
      groups: this.deps.groups(),
      speech: this.deps.speech(),
    });
    return (this.home = { view, json: JSON.stringify(view), at: Date.now() });
  }
  private homeFor(session: RemoteSession) {
    const home = this.homeNow();
    session.homeJson = home.json;
    return home.view;
  }

  private openChat(session: RemoteSession, botId: string, sessionId?: string): ChatView {
    const store = this.deps.store;
    store.bot(botId);
    if (sessionId && !store.data.workSessions?.some((item) => item.id === sessionId && item.botId === botId))
      fail('session.not_found', '工作会话不存在');
    const all = chatMessages(store, botId, sessionId),
      start = windowStart(all, all.length);
    const messages = all.slice(start).map(trimMessage),
      runs = windowRuns(store, messages),
      streams = chatStreams(this.deps.streams(), botId, sessionId),
      permission = this.deps.permissionMode({ kind: 'bot', id: botId, ...(sessionId ? { sessionId } : {}) });
    const key = chatKey(botId, sessionId);
    session.chat = {
      key,
      botId,
      ...(sessionId ? { sessionId } : {}),
      ...(messages[0] ? { startId: messages[0].id } : {}),
      hasMore: start > 0,
      messages: diffEntities(emptyBaseline(), messages).baseline,
      runs: diffEntities(emptyBaseline(), runs).baseline,
      streams: JSON.stringify(streams),
      permission,
    };
    return { key, botId, ...(sessionId ? { sessionId } : {}), messages, runs, streams, hasMore: start > 0, permission };
  }

  /** Older messages of the open chat: the window grows by WINDOW_TURNS turns. */
  private moreChat(session: RemoteSession, key: string) {
    const chat = session.chat;
    if (!chat || chat.key !== key) fail('remote.no_chat', '对话已关闭');
    this.chatTick(session);
    const all = chatMessages(this.deps.store, chat!.botId, chat!.sessionId);
    const end = chat!.startId
      ? Math.max(
          0,
          all.findIndex((message) => message.id === chat!.startId),
        )
      : all.length;
    const start = windowStart(all, end, WINDOW_TURNS);
    const older = all.slice(start, end).map(trimMessage);
    const window = all.slice(start).map(trimMessage);
    if (older[0]) chat!.startId = older[0].id;
    chat!.hasMore = start > 0;
    chat!.messages = diffEntities(emptyBaseline(), window).baseline;
    const runs = windowRuns(this.deps.store, window);
    chat!.runs = diffEntities(emptyBaseline(), runs).baseline;
    const olderRuns = new Set(older.map((message) => message.runId).filter(Boolean));
    return { messages: older, runs: runs.filter((run) => olderRuns.has(run.id)), hasMore: chat!.hasMore };
  }

  private chatTick(session: RemoteSession, streamsOnly = false) {
    const chat = session.chat;
    if (!chat) return;
    const delta: ChatDelta = { key: chat.key };
    let changed = false;
    if (!streamsOnly) {
      const all = chatMessages(this.deps.store, chat.botId, chat.sessionId);
      let start = chat.startId ? all.findIndex((message) => message.id === chat.startId) : 0;
      // The first message of the window is gone (retracted): start from the turn window again.
      if (start < 0) start = windowStart(all, all.length);
      const window = all.slice(start).map(trimMessage);
      chat.startId = window[0]?.id;
      const messages = diffEntities(chat.messages, window);
      chat.messages = messages.baseline;
      if (messages.delta) {
        delta.messages = messages.delta;
        changed = true;
      }
      const runs = diffEntities(chat.runs, windowRuns(this.deps.store, window));
      chat.runs = runs.baseline;
      if (runs.delta) {
        delta.runs = runs.delta;
        changed = true;
      }
      const permission = this.deps.permissionMode({
        kind: 'bot',
        id: chat.botId,
        ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
      });
      if (permission !== chat.permission) {
        chat.permission = delta.permission = permission;
        changed = true;
      }
    }
    const streams = chatStreams(this.deps.streams(), chat.botId, chat.sessionId),
      streamsJson = JSON.stringify(streams);
    if (streamsJson !== chat.streams) {
      chat.streams = streamsJson;
      delta.streams = streams;
      changed = true;
    }
    if (changed) session.event('chat', delta);
  }

  private groupStamp(id: string) {
    const room = this.deps.groups()?.rooms.find((item) => item.id === id);
    return JSON.stringify(
      room ? [room.lastSeq, room.updatedAt, room.activities, room.activity, room.round, room.pending] : null,
    );
  }

  private async openComputer(session: RemoteSession, botId: string) {
    this.deps.store.bot(botId);
    await this.deps.call('ensureComputerDesktop', botId);
    const url = this.deps.computer.stateFor(botId).vncUrl;
    if (!url) fail('remote.no_desktop', '工作电脑桌面还没有准备好');
    const socket = this.deps.connectDesktop?.(url!) ?? new WebSocket(url!, { perMessageDeflate: false });
    const queued: Uint8Array[] = [];
    let id = 0;
    const stream = {
      write: (data: Uint8Array) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
        else if (socket.readyState === WebSocket.CONNECTING) queued.push(data.slice());
      },
      close: () => socket.close(),
    };
    id = session.addStream(stream);
    socket.on('open', () => {
      for (const data of queued.splice(0)) socket.send(data);
    });
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      session.sendStream(id, bytes);
    });
    socket.on('error', () => socket.close());
    socket.on('close', () => {
      if (session.streams.delete(id)) session.event('stream.close', { stream: id });
    });
    return { stream: id };
  }

  // ---------- Updates ----------

  /** The app's state changed: refresh what phones see, soon and at most every TICK_MS. */
  changed() {
    if (!this.enabled || this.tickTimer) return;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(0, this.lastTick + TICK_MS - Date.now()));
  }

  /** Live replies changed: refresh the open chats' streams only. */
  streamsChanged() {
    if (!this.enabled || this.streamTimer || this.tickTimer) return;
    this.streamTimer = setTimeout(
      () => {
        this.streamTimer = undefined;
        this.lastStreams = Date.now();
        for (const session of this.sessions.values()) if (session.ready) this.chatTick(session, true);
      },
      Math.max(0, this.lastStreams + STREAM_TICK_MS - Date.now()),
    );
  }

  /** Entries edited in place: their trimmed copies are stale. */
  markEdited(entries: object[]) {
    forgetTrimmed(entries);
  }

  private tick() {
    this.tickTimer = undefined;
    this.lastTick = Date.now();
    const ready = [...this.sessions.values()].filter((session) => session.ready);
    if (ready.some((session) => session.wantsHome)) {
      this.home = undefined;
      const home = this.homeNow();
      for (const session of ready)
        if (session.wantsHome && session.homeJson !== home.json) {
          session.homeJson = home.json;
          session.event('home', home.view);
        }
    }
    for (const session of ready) {
      this.chatTick(session);
      const group = session.group;
      if (group) {
        const stamp = this.groupStamp(group.id);
        if (stamp !== group.stamp) {
          group.stamp = stamp;
          void this.deps.call('readGroup', { id: group.id }).then(
            (page) => session.group?.id === group.id && session.event('group', page as GroupPage),
            () => {},
          );
        }
      }
    }
    this.notifications();
  }

  // ---------- Notifications ----------

  private notifications() {
    const store = this.deps.store,
      requests = this.deps.interactions();
    const running = new Set(store.data.runs.filter((run) => run.status === 'running').map((run) => run.id));
    const firstLook = !this.seenRequests || !this.runningRuns;
    const newRequests = firstLook ? [] : requests.filter((request) => !this.seenRequests!.has(request.id));
    const finished = firstLook ? [] : [...this.runningRuns!].filter((id) => !running.has(id));
    this.seenRequests = new Set(requests.map((request) => request.id));
    this.runningRuns = running;
    if (!this.store.data.devices.some((device) => device.push)) return;
    for (const request of newRequests) this.notifyRequest(request);
    for (const id of finished) {
      const run = store.data.runs.find((item) => item.id === id);
      if (run && !run.groupOrigin && !run.peerOrigin && !run.retracted && run.status !== 'cancelled')
        this.notifyRun(run);
    }
  }

  private botTitle(botId: string, sessionId?: string) {
    const store = this.deps.store,
      bot = store.data.bots.find((item) => item.id === botId);
    const session = sessionId ? store.data.workSessions?.find((item) => item.id === sessionId) : undefined;
    return (bot?.name || 'AelionBot') + (session ? ' · ' + session.name : '');
  }

  private notifyRequest(request: InteractionRequest) {
    const run = this.deps.store.data.runs.find((item) => item.id === request.runId);
    const sessionId = run?.sessionId,
      key = chatKey(request.botId, sessionId);
    const detail =
      request.kind === 'host_permission'
        ? request.details.command || request.details.path || request.details.tool || ''
        : request.kind === 'user_input'
          ? request.questions[0]?.title || ''
          : '';
    const general =
      request.kind === 'user_input'
        ? translate('有问题想问你')
        : request.kind === 'vm_takeover'
          ? translate('需要你处理工作电脑')
          : translate('需要你批准一个操作');
    for (const device of this.store.data.devices) {
      if (!device.push || !device.notify.requests || this.visible(device)) continue;
      void this.push(
        device,
        {
          title: this.botTitle(request.botId, sessionId),
          body: device.notify.content && detail ? general + '：' + detail.slice(0, 160) : general,
          tag: 'request-' + request.id.slice(0, 20),
          url: this.chatUrl(request.botId, sessionId),
        },
        'high',
        key,
      );
    }
  }

  private notifyRun(run: { id: string; botId: string; sessionId?: string; status: string; startedAt: string }) {
    if (this.deps.idleSeconds() < PRESENT_SECONDS) return;
    const store = this.deps.store,
      key = chatKey(run.botId, run.sessionId);
    const automation = store.data.scheduledTasks?.some(
      (task) =>
        task.lastRun &&
        task.target.kind === 'bot' &&
        task.target.id === run.botId &&
        (task.target.sessionId || undefined) === run.sessionId &&
        Math.abs(Date.parse(task.lastRun.startedAt) - Date.parse(run.startedAt)) < 15_000,
    );
    const answer = [...store.data.messages]
      .reverse()
      .find((message) => message.runId === run.id && message.role === 'assistant' && message.status !== 'running');
    const failed = run.status !== 'completed';
    const general = failed ? translate('任务没有完成') : translate('任务完成了');
    for (const device of this.store.data.devices) {
      if (!device.push || !(automation ? device.notify.automations : device.notify.finished)) continue;
      if (this.visible(device, key)) continue;
      const preview = answer ? previewText(readableContent(answer.content), answer.attachments) : '';
      void this.push(
        device,
        {
          title: this.botTitle(run.botId, run.sessionId),
          body: device.notify.content && preview ? preview : general,
          tag: 'chat-' + key.slice(0, 40),
          url: this.chatUrl(run.botId, run.sessionId),
        },
        'normal',
        key,
      );
    }
  }

  /** The phone shows the app in the foreground (on this chat, when given): it sees the change itself. */
  private visible(device: StoredDevice, chat?: string) {
    return [...this.sessions.values()].some(
      (session) =>
        session.ready &&
        session.device?.id === device.id &&
        session.presence.visible &&
        (!chat || session.presence.chat === chat),
    );
  }

  private chatUrl(botId: string, sessionId?: string) {
    return '/#/chat/' + encodeURIComponent(botId) + (sessionId ? '/' + encodeURIComponent(sessionId) : '');
  }

  private async push(
    device: StoredDevice,
    payload: PushPayload,
    urgency: 'normal' | 'high' = 'normal',
    topic?: string,
  ) {
    const subscription = this.store.pushSubscription(device);
    if (!subscription) return false;
    const repeatKey = device.id + payload.tag,
      last = this.pushedAt.get(repeatKey) || 0;
    if (payload.tag !== 'test' && Date.now() - last < PUSH_REPEAT_MS) return true;
    this.pushedAt.set(repeatKey, Date.now());
    try {
      const keys = (this.keys ??= await this.store.loadKeys());
      const result = await sendPush({
        subscription,
        payload,
        vapid: { privateKey: keys.vapid.privateKey, publicKey: keys.vapidPublic, subject: this.appUrl },
        urgency,
        ...(topic ? { topic: toBase64Url(new TextEncoder().encode(topic)).slice(0, 32) } : {}),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      if (result.gone) {
        this.store.setPushSubscription(device, undefined);
        this.store.save();
        this.deps.changed();
      }
      return result.status >= 200 && result.status < 300;
    } catch {
      return false;
    }
  }
}
