// Connectors: IM accounts through which people message their Bot. The hub runs each connector's adapter, lets in only
// the owner and the people the owner approved, maps every private or group chat to a work session of the bound Bot and
// hands messages to the chat queue like the app's own composer. Replies go back through the outbox.
import { randomInt, randomUUID } from 'node:crypto';
import {
  CONNECTOR_PLATFORM_NAMES,
  type ConnectorCreateInput,
  type ConnectorPlatform,
  type ConnectorSetupInput,
  type ConnectorStatus,
  type ConnectorUpdateInput,
  type ConnectorsView,
  type MessageConnectorSource,
} from '../../../shared/types/connector-types';
import type { WorkSession } from '../../../shared/types/core';
import type { AttachmentScope, AttachmentUpload } from '../../../shared/types/attachment-types';
import { HOST_PERMISSION_MODES, type HostPermissionMode } from '../../../shared/types/permission-types';
import { AppError } from '../../../shared/errors';
import type { Store } from '../storage/store';
import type { HarnessRunOptions } from '../agent/peer-runtime-types';
import type { AdapterHandlers, ConnectorAdapter, InboundMessage } from './connector-adapter';
import { ConnectorOutbox, ownerChat, type OutboxHost } from './connector-outbox';
import { ConnectorSetups, type SetupResult } from './connector-setup';
import { ConnectorStore, connectorView, type SecretCodec, type StoredConnector } from './connector-store';
import { FeishuAdapter, type LarkSdk } from './adapters/feishu';
import { WecomAdapter } from './adapters/wecom';
import { WeixinAdapter, type WeixinCredentials } from './adapters/weixin';

export interface ConnectorDeps {
  store: Store;
  dataDir: string;
  codec: SecretCodec;
  version: string;
  attachments: {
    importFiles(scope: AttachmentScope, files: AttachmentUpload[]): Array<{ id: string }>;
    bytes(id: string): Buffer;
  };
  /** Queues a message in a work session, like the app's composer. */
  send(input: {
    botId: string;
    sessionId: string;
    message: string;
    attachmentIds: string[];
    connector: MessageConnectorSource;
  }): void;
  cancel(botId: string, sessionId: string): void;
  isRunning(botId: string, sessionId: string): boolean;
  setPermission(botId: string, sessionId: string, mode: HostPermissionMode): void;
  interactions: OutboxHost['interactions'];
  changed(): void;
  lark(): LarkSdk;
  /** Replaces the platform adapters in tests. */
  createAdapter?(connector: StoredConnector, credentials: Record<string, string>): ConnectorAdapter;
  fetch?: typeof fetch;
}
interface Running {
  adapter: ConnectorAdapter;
  status: ConnectorStatus;
  issue?: string;
  /** Messages of one chat are handled in order, each after the previous one's files arrived. */
  chats: Map<string, Promise<void>>;
}
/** A message older than this arrived while the app was closed or offline. */
const STALE_MS = 10 * 60_000;
const PAIRINGS_KEPT = 20;
const MESSAGE_CHARS = 30_000;
const HELP = ['可以直接发消息、图片和文件给我。', '/new 开始新会话', '/stop 停止当前任务', '/status 查看状态'].join(
  '\n',
);

export class Connectors {
  readonly saved: ConnectorStore;
  private outbox: ConnectorOutbox;
  private setups: ConnectorSetups;
  private running = new Map<string, Running>();
  private closed = false;
  constructor(private deps: ConnectorDeps) {
    this.saved = new ConnectorStore(deps.dataDir, deps.codec);
    this.setups = new ConnectorSetups({ lark: deps.lark, changed: deps.changed, fetch: deps.fetch });
    this.outbox = new ConnectorOutbox({
      store: deps.store,
      connector: (id) => this.saved.get(id),
      adapter: (id) => {
        const running = this.running.get(id);
        return running?.status === 'connected' ? running.adapter : undefined;
      },
      bytes: (id) => deps.attachments.bytes(id),
      interactions: deps.interactions,
      journal: (type, payload) => deps.store.journal(type, payload),
    });
  }
  start() {
    for (const connector of this.saved.data.connectors) if (connector.enabled) this.connect(connector);
  }
  snapshot(): ConnectorsView {
    return {
      keepRunning: this.saved.data.keepRunning,
      connectors: this.saved.data.connectors.map((connector) => {
        const running = this.running.get(connector.id);
        return connectorView(connector, {
          status: running?.status || 'connecting',
          ...(running?.issue ? { issue: running.issue } : {}),
        });
      }),
      setups: this.setups.views(),
    };
  }
  /** Whether closing the window should keep the app running for connectors. */
  get keepRunning() {
    return this.saved.data.keepRunning && this.saved.data.connectors.some((connector) => connector.enabled);
  }
  setKeepRunning(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new AppError('connector.input_invalid', '无效设置');
    this.saved.data.keepRunning = enabled;
    this.saved.save();
    this.deps.changed();
  }
  /** Connector sessions take their permission mode from the connector, so the app does not set it per session. */
  sessionLocked(sessionId: string | undefined) {
    const session = sessionId ? this.deps.store.data.workSessions?.find((item) => item.id === sessionId) : undefined;
    return Boolean(session?.connector && this.saved.get(session.connector.connectorId));
  }
  wrapRun(botId: string, options: HarnessRunOptions, start: (options: HarnessRunOptions) => Promise<void>) {
    return this.outbox.wrapRun(botId, options, start);
  }
  interactionsChanged() {
    this.outbox.interactionsChanged();
  }

  // ---- Settings ----
  private bot(botId: unknown) {
    const bot = this.deps.store.data.bots.find((item) => item.id === botId);
    if (!bot) throw new AppError('connector.bot_missing', '请选择要连接的 Bot');
    return bot;
  }
  private mode(value: unknown) {
    if (!HOST_PERMISSION_MODES.some((item) => item.id === value))
      throw new AppError('permission.mode_invalid', '无效权限模式');
    return value as HostPermissionMode;
  }
  private find(id: unknown) {
    const connector = typeof id === 'string' ? this.saved.get(id) : undefined;
    if (!connector) throw new AppError('connector.not_found', '连接器不存在');
    return connector;
  }
  private create(
    platform: ConnectorPlatform,
    account: string,
    credentials: object,
    botId: string,
    mode: HostPermissionMode,
    owner?: string,
  ) {
    if (
      this.saved.data.connectors.some((connector) => connector.platform === platform && connector.account === account)
    )
      throw new AppError('connector.duplicate', '这个账号已经添加过了');
    const connector: StoredConnector = {
      id: randomUUID(),
      platform,
      botId,
      enabled: true,
      permissionMode: mode,
      ...(owner ? { owner: { id: owner } } : {}),
      allowed: [],
      pairings: [],
      account,
      secret: this.saved.encrypt(credentials),
      createdAt: new Date().toISOString(),
    };
    this.saved.data.connectors.push(connector);
    this.saved.save();
    this.connect(connector);
    this.deps.changed();
    return connector.id;
  }
  add(input: ConnectorCreateInput) {
    const bot = this.bot(input?.botId),
      mode = this.mode(input?.permissionMode),
      value = input?.credentials,
      text = (field: unknown, name: string) => {
        if (typeof field !== 'string' || !field.trim() || field.trim().length > 400)
          throw new AppError('connector.credentials_invalid', `请填写 ${name}`);
        return field.trim();
      };
    if (value?.platform === 'feishu') {
      const appId = text(value.appId, 'App ID'),
        appSecret = text(value.appSecret, 'App Secret');
      return this.create('feishu', appId, { appId, appSecret }, bot.id, mode);
    }
    if (value?.platform === 'wecom') {
      const botId = text(value.botId, 'BotID'),
        secret = text(value.secret, 'Secret');
      return this.create('wecom', botId, { botId, secret }, bot.id, mode);
    }
    throw new AppError('connector.platform_invalid', '不支持的平台');
  }
  startSetup(input: ConnectorSetupInput) {
    const bot = this.bot(input?.botId),
      mode = this.mode(input?.permissionMode);
    if (input?.platform !== 'feishu' && input?.platform !== 'weixin')
      throw new AppError('connector.platform_invalid', '不支持的平台');
    return this.setups.start(input.platform, bot.name, (result: SetupResult) =>
      result.platform === 'feishu'
        ? this.create('feishu', result.credentials.appId, result.credentials, bot.id, mode, result.ownerId)
        : this.create(
            'weixin',
            result.credentials.accountId,
            result.credentials,
            bot.id,
            mode,
            result.credentials.userId || undefined,
          ),
    );
  }
  answerSetup(input: { id: string; verifyCode: string }) {
    this.setups.answer(String(input?.id), String(input?.verifyCode ?? ''));
  }
  cancelSetup(id: string) {
    this.setups.cancel(String(id));
  }
  update(input: ConnectorUpdateInput) {
    const connector = this.find(input?.id);
    let reconnect = false;
    if (input.botId !== undefined && input.botId !== connector.botId) {
      connector.botId = this.bot(input.botId).id;
      reconnect = true;
    }
    if (input.permissionMode !== undefined) {
      connector.permissionMode = this.mode(input.permissionMode);
      for (const session of this.sessions(connector.id))
        this.deps.setPermission(session.botId, session.id, connector.permissionMode);
    }
    if (input.removeAllowed !== undefined) {
      if (!Array.isArray(input.removeAllowed)) throw new AppError('connector.input_invalid', '无效设置');
      connector.allowed = connector.allowed.filter((person) => !input.removeAllowed!.includes(person.id));
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new AppError('connector.input_invalid', '无效设置');
      if (input.enabled !== connector.enabled) {
        connector.enabled = input.enabled;
        reconnect = true;
      }
    }
    this.saved.save();
    if (reconnect) {
      if (connector.enabled) this.connect(connector);
      else void this.disconnect(connector.id);
    }
    this.deps.changed();
  }
  async remove(id: string) {
    const connector = this.find(id);
    await this.disconnect(connector.id);
    // Its sessions stay as ordinary work sessions, with the permission mode they had.
    for (const session of this.sessions(connector.id)) delete session.connector;
    this.deps.store.save();
    this.saved.data.connectors = this.saved.data.connectors.filter((item) => item.id !== connector.id);
    this.saved.save();
    this.deps.changed();
  }
  reconnect(id: string) {
    const connector = this.find(id);
    if (!connector.enabled) throw new AppError('connector.disabled', '请先启用这个连接器');
    this.connect(connector);
    this.deps.changed();
  }
  async decidePairing(input: { id: string; code: string; allow: boolean }) {
    const connector = this.find(input?.id),
      pairing = connector.pairings.find((item) => item.code === input?.code);
    if (!pairing) throw new AppError('connector.pairing_missing', '配对请求已失效');
    connector.pairings = connector.pairings.filter((item) => item !== pairing);
    if (input.allow) {
      const person = { id: pairing.id, ...(pairing.name ? { name: pairing.name } : {}), chatId: pairing.chatId };
      if (!connector.owner) connector.owner = person;
      else if (!connector.allowed.some((item) => item.id === person.id)) connector.allowed.push(person);
    }
    this.saved.save();
    this.deps.changed();
    if (input.allow)
      await this.running
        .get(connector.id)
        ?.adapter.sendText(pairing.chatId, `已确认，现在可以直接给 ${this.botName(connector.botId)} 发消息了。`)
        .catch(() => {});
  }

  // ---- Connections ----
  private connect(connector: StoredConnector) {
    void this.disconnect(connector.id);
    if (this.closed) return;
    const fail = (status: ConnectorStatus, issue: string) => {
      this.running.set(connector.id, { adapter: idleAdapter(connector.platform), status, issue, chats: new Map() });
    };
    if (!this.deps.store.data.bots.some((bot) => bot.id === connector.botId))
      return fail('needs-config', '绑定的 Bot 已删除，请重新选择 Bot');
    let credentials: Record<string, string>;
    try {
      credentials = this.saved.credentials(connector);
    } catch {
      return fail('needs-config', '无法读取保存的凭证，请删除后重新添加');
    }
    let adapter: ConnectorAdapter;
    try {
      adapter = this.deps.createAdapter
        ? this.deps.createAdapter(connector, credentials)
        : this.adapterFor(connector, credentials);
    } catch (error) {
      return fail('error', (error as Error).message);
    }
    const running: Running = { adapter, status: 'connecting', chats: new Map() };
    this.running.set(connector.id, running);
    const current = () => this.running.get(connector.id) === running;
    const handlers: AdapterHandlers = {
      status: (status, issue) => {
        if (!current()) return;
        running.status = status;
        running.issue = issue;
        this.deps.changed();
      },
      message: (message) => {
        if (!current()) return;
        const chain = (running.chats.get(message.chatId) || Promise.resolve())
          .then(() => this.receive(connector.id, message, adapter))
          .catch((error) => this.deps.store.journal('connector.receive-error', { error: (error as Error).message }));
        running.chats.set(message.chatId, chain);
        void chain.finally(() => {
          if (running.chats.get(message.chatId) === chain) running.chats.delete(message.chatId);
        });
      },
      action: async (action) => {
        const saved = this.saved.get(connector.id);
        return current() && saved ? this.outbox.action(saved, action) : undefined;
      },
      credentials: (value) => {
        const saved = this.saved.get(connector.id);
        if (!saved) return;
        this.saved.setCredentials(saved, { ...this.saved.credentials(saved), ...value });
        this.saved.save();
      },
      state: (value) => {
        const saved = this.saved.get(connector.id);
        if (!saved) return;
        saved.state = { ...saved.state, ...value };
        this.saved.save();
      },
    };
    adapter.start(handlers);
  }
  private adapterFor(connector: StoredConnector, credentials: Record<string, string>): ConnectorAdapter {
    if (connector.platform === 'feishu')
      return new FeishuAdapter({ appId: credentials.appId, appSecret: credentials.appSecret }, this.deps.lark);
    if (connector.platform === 'wecom')
      return new WecomAdapter({ botId: credentials.botId, secret: credentials.secret }, { fetch: this.deps.fetch });
    let contexts: Record<string, string> = {};
    try {
      contexts = JSON.parse(connector.state?.contexts || '{}');
    } catch {}
    return new WeixinAdapter(
      credentials as unknown as WeixinCredentials,
      connector.state?.cursor || '',
      this.deps.version,
      this.deps.fetch,
      undefined,
      contexts,
    );
  }
  private async disconnect(id: string) {
    const running = this.running.get(id);
    this.running.delete(id);
    await running?.adapter.stop().catch(() => {});
  }

  // ---- Messages ----
  private botName(botId: string) {
    return this.deps.store.data.bots.find((bot) => bot.id === botId)?.name || 'Bot';
  }
  private sessions(connectorId: string) {
    return (this.deps.store.data.workSessions || []).filter(
      (session) => session.connector?.connectorId === connectorId,
    );
  }
  private say(adapter: ConnectorAdapter, chatId: string, text: string) {
    return adapter
      .sendText(chatId, text)
      .catch((error) => this.deps.store.journal('connector.send-error', { error: (error as Error).message }));
  }
  private async receive(id: string, message: InboundMessage, adapter: ConnectorAdapter) {
    const connector = this.saved.get(id);
    if (!connector || !message.messageId || !message.chatId || !message.sender.id) return;
    if (!this.saved.remember(connector, message.messageId)) return;
    // WeCom only pushes group messages that mention the Bot. Other platforms deliver every group message, so their
    // groups stay off until their adapters can tell whether the Bot was addressed.
    if (message.isGroup && connector.platform !== 'wecom') return void this.saved.save();
    connector.lastMessageAt = new Date().toISOString();
    const person = message.sender,
      isOwner = connector.owner?.id === person.id,
      allowed = connector.allowed.find((item) => item.id === person.id);
    if (!isOwner && !allowed) {
      // Only the owner and people they approved can wake the Bot in a group; strangers are not paired there.
      if (message.isGroup) return void this.saved.save();
      this.saved.save();
      return this.pair(connector, message, adapter);
    }
    // Remember the private chat that reaches this person, for approvals sent to the owner later. A group message
    // must not replace it, or approvals would be posted where everyone in the group can see them.
    const record = isOwner ? connector.owner! : allowed!;
    if ((!message.isGroup && record.chatId !== message.chatId) || (person.name && record.name !== person.name)) {
      if (!message.isGroup) record.chatId = message.chatId;
      if (person.name) record.name = person.name;
    }
    this.saved.save();
    this.deps.changed();
    if (await this.outbox.reply(connector, message, adapter)) return;
    if (!this.deps.store.data.bots.some((bot) => bot.id === connector.botId))
      return void this.say(adapter, message.chatId, '这个连接器绑定的 Bot 已删除，请在电脑上重新选择 Bot。');
    const command = /^\/(new|stop|status|help)\s*$/i.exec(message.text.trim())?.[1]?.toLowerCase();
    if (command) return this.command(connector, message, adapter, command);
    // A group message that is only the @mention has nothing to do.
    if (message.isGroup && !message.text.trim() && !message.resources.length) return;
    const session = this.session(connector, message);
    if (Date.now() - message.sentAt > STALE_MS)
      await this.say(adapter, message.chatId, '刚上线，看到你之前发的消息了，现在开始处理。');
    const files: AttachmentUpload[] = [],
      notes: string[] = [];
    for (const resource of message.resources)
      try {
        const file = await resource.fetch(AbortSignal.timeout(120_000));
        files.push({ name: file.name, bytes: file.bytes });
      } catch (error) {
        notes.push(`（有一个${resource.kind === 'image' ? '图片' : '文件'}没能收下：${(error as Error).message}）`);
      }
    let attachmentIds: string[] = [];
    if (files.length)
      try {
        attachmentIds = this.deps.attachments
          .importFiles({ kind: 'bot', id: connector.botId }, files)
          .map((file) => file.id);
      } catch (error) {
        notes.push(`（附件没能收下：${(error as Error).message}）`);
      }
    const quoted = message.quoted ? `> ${message.quoted.split('\n').slice(0, 6).join('\n> ')}\n\n` : '';
    let text = quoted + [message.text, ...notes].filter(Boolean).join('\n');
    if (text.length > MESSAGE_CHARS) text = text.slice(0, MESSAGE_CHARS) + '\n（消息过长，后面的内容没有收下）';
    if (!text.trim() && !attachmentIds.length) return;
    try {
      this.deps.send({
        botId: connector.botId,
        sessionId: session.id,
        message: text,
        attachmentIds,
        connector: {
          connectorId: connector.id,
          platform: connector.platform,
          messageId: message.messageId,
          ...(message.isGroup ? { isGroup: true } : {}),
          sender: { id: person.id, ...(record.name ? { name: record.name } : {}) },
        },
      });
    } catch (error) {
      await this.say(adapter, message.chatId, '这条消息没能交给 Bot：' + (error as Error).message);
    }
  }
  /** The open work session for this chat, created on its first message. */
  private session(connector: StoredConnector, message: InboundMessage) {
    const sessions = (this.deps.store.data.workSessions ||= []);
    const existing = sessions.find(
      (session) =>
        session.connector?.connectorId === connector.id &&
        session.connector.chatId === message.chatId &&
        session.botId === connector.botId &&
        !session.archivedAt,
    );
    if (existing) return existing;
    const platform = CONNECTOR_PLATFORM_NAMES[connector.platform],
      isOwner = connector.owner?.id === message.sender.id,
      who = message.sender.name || connector.allowed.find((item) => item.id === message.sender.id)?.name;
    const now = new Date().toISOString(),
      session: WorkSession = {
        id: randomUUID(),
        botId: connector.botId,
        name: message.isGroup
          ? `${platform} · 群聊`
          : isOwner
            ? platform
            : `${platform} · ${who || message.sender.id.slice(-6)}`,
        createdAt: now,
        updatedAt: now,
        connector: {
          connectorId: connector.id,
          platform: connector.platform,
          chatId: message.chatId,
          peer: { id: message.sender.id, ...(who ? { name: who } : {}) },
        },
      };
    sessions.push(session);
    this.deps.setPermission(session.botId, session.id, connector.permissionMode);
    this.deps.store.save();
    this.deps.changed();
    return session;
  }
  private async command(
    connector: StoredConnector,
    message: InboundMessage,
    adapter: ConnectorAdapter,
    command: string,
  ) {
    const session = this.deps.store.data.workSessions?.find(
      (item) =>
        item.connector?.connectorId === connector.id &&
        item.connector.chatId === message.chatId &&
        item.botId === connector.botId &&
        !item.archivedAt,
    );
    if (command === 'help') return this.say(adapter, message.chatId, HELP);
    if (command === 'new') {
      if (session) {
        if (this.deps.isRunning(session.botId, session.id)) this.deps.cancel(session.botId, session.id);
        session.archivedAt = new Date().toISOString();
        this.deps.store.save();
        this.deps.changed();
      }
      return this.say(adapter, message.chatId, '好的，下一条消息会开始新的会话。');
    }
    if (command === 'stop') {
      if (session && this.deps.isRunning(session.botId, session.id)) {
        this.deps.cancel(session.botId, session.id);
        return this.say(adapter, message.chatId, '已停止当前任务。');
      }
      return this.say(adapter, message.chatId, '现在没有进行中的任务。');
    }
    const busy = session && this.deps.isRunning(session.botId, session.id);
    return this.say(
      adapter,
      message.chatId,
      `${this.botName(connector.botId)}：${busy ? '正在处理任务' : '空闲'}${session ? `\n会话：${session.name}` : ''}`,
    );
  }
  /** Someone not yet allowed: a pairing code the user confirms in the app. */
  private async pair(connector: StoredConnector, message: InboundMessage, adapter: ConnectorAdapter) {
    if (connector.pairings.some((item) => item.id === message.sender.id)) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    connector.pairings.push({
      id: message.sender.id,
      ...(message.sender.name ? { name: message.sender.name } : {}),
      code,
      chatId: message.chatId,
      requestedAt: new Date().toISOString(),
    });
    if (connector.pairings.length > PAIRINGS_KEPT)
      connector.pairings.splice(0, connector.pairings.length - PAIRINGS_KEPT);
    this.saved.save();
    this.deps.changed();
    await this.say(
      adapter,
      message.chatId,
      connector.owner
        ? `你还没有使用权限，已把请求发给 Bot 的主人。配对码：${code}`
        : `配对码：${code}\n请在电脑上的 AelionBot 打开“插件 → 连接器”，确认这个配对码。确认后就可以直接给 ${this.botName(connector.botId)} 发消息了。`,
    );
    const owner = ownerChat(connector);
    if (connector.owner && owner)
      await this.say(
        adapter,
        owner,
        `${message.sender.name || '有人'}请求使用 ${this.botName(connector.botId)}，请在电脑上的“插件 → 连接器”里确认配对码 ${code}。`,
      );
  }
  async dispose() {
    this.closed = true;
    this.setups.dispose();
    this.outbox.dispose();
    await Promise.all([...this.running.keys()].map((id) => this.disconnect(id)));
  }
}

/** Stands in for a connector that could not start, so its status shows and sends fail plainly. */
function idleAdapter(platform: ConnectorPlatform): ConnectorAdapter {
  const offline = async () => {
    throw new AppError('connector.offline', '连接器未连接');
  };
  return { platform, start: () => {}, stop: async () => {}, sendText: offline, sendFile: offline };
}
