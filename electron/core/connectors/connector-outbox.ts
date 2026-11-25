// Replies from the Bot back to connector chats: live streaming where the platform supports it, intermediate text
// turns as they finish, final answer with its files, plus approval cards for the connector's owner and questions for
// whoever asked. While the Bot works the chat shows the platform's typing cue. Only runs started by connector
// messages, or by scheduled tasks in connector sessions, are sent; work started in the app stays in the app.
import type { InteractionRequest } from '../../../shared/types/core';
import type { HarnessRunOptions } from '../agent/peer-runtime-types';
import type { Store } from '../storage/store';
import type {
  ConnectorAdapter,
  ConnectorCard,
  ConnectorTextStream,
  InboundAction,
  InboundMessage,
} from './connector-adapter';
import type { StoredConnector } from './connector-store';
import type { VoiceClip, VoiceFormat } from '../speech/speech-service';
import { connectorStreamingText, connectorText, permissionSummary } from './format';

export interface OutboxHost {
  store: Store;
  connector(id: string): StoredConnector | undefined;
  /** The adapter of a running connector. */
  adapter(id: string): ConnectorAdapter | undefined;
  bytes(attachmentId: string): Buffer;
  /** A reply read aloud as voice messages, when voice replies are on and the reply is short enough to listen to. */
  voice(botId: string, text: string, format: VoiceFormat, signal: AbortSignal): Promise<VoiceClip[] | undefined>;
  /** An audio attachment as voice messages; undefined when it is too long or cannot be encoded here. */
  voiceClips(attachmentId: string, format: VoiceFormat, signal: AbortSignal): Promise<VoiceClip[] | undefined>;
  interactions: {
    snapshot(): InteractionRequest[];
    approve(id: string, allow: boolean): void;
    decideComputerAccess(id: string, allow: boolean): void;
    decideVaultUse?(id: string, decision: 'allow' | 'allow-run' | 'deny'): void;
    answer(id: string, value: unknown): void;
  };
  journal(type: string, payload: unknown): void;
}
const DEFAULT_STREAM_INTERVAL_MS = 500;

/**
 * Throttles and serializes one live-updated message to an adapter. The first non-empty chunk flushes immediately (after
 * any preceding message in the same run finishes); later updates wait for the in-flight request and `intervalMs`.
 */
class LiveMessageStream {
  private stream?: ConnectorTextStream;
  private latest = '';
  private sent = '';
  private opened = false;
  private degraded = false;
  private finished = false;
  private lastFlushAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  constructor(
    private chatId: string,
    private adapter: () => ConnectorAdapter | undefined,
    private prior: Promise<void>,
    private onError: (error: unknown) => void,
  ) {}
  push(text: string) {
    if (this.finished || this.degraded) return;
    if (!text) {
      this.latest = '';
      return;
    }
    this.latest = text;
    if (this.latest === this.sent) return;
    this.schedule();
  }
  private intervalMs() {
    return Math.max(0, this.stream?.intervalMs ?? DEFAULT_STREAM_INTERVAL_MS);
  }
  private schedule() {
    if (this.finished || this.degraded || this.inFlight || this.timer) return;
    const wait = this.opened ? Math.max(0, this.lastFlushAt + this.intervalMs() - Date.now()) : 0;
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }
  private flush() {
    if (this.finished || this.degraded || this.inFlight) return;
    const text = this.latest;
    if (!text || text === this.sent) return;
    const adapter = this.adapter();
    if (!adapter) return;
    if (!this.stream) {
      const created = adapter.beginStream?.(this.chatId);
      if (!created) {
        this.degraded = true;
        return;
      }
      this.stream = created;
    }
    const stream = this.stream;
    this.lastFlushAt = Date.now();
    this.inFlight = (async () => {
      try {
        await this.prior;
        if (this.finished || this.degraded) return;
        const current = this.latest;
        if (!current || current === this.sent) return;
        this.opened = true;
        await stream.update(current);
        this.sent = current;
      } catch (error) {
        this.degraded = true;
        this.onError(error);
      } finally {
        this.inFlight = undefined;
        if (!this.finished && !this.degraded && this.latest && this.latest !== this.sent) this.schedule();
      }
    })();
  }
  async finish(finalText: string) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) await this.inFlight;
    const adapter = this.adapter();
    if (!adapter) return;
    if (this.stream && this.opened) {
      try {
        await this.stream.finish(finalText);
        return;
      } catch (error) {
        this.onError(error);
        if (this.sent || !finalText) return;
      }
    }
    if (!finalText) return;
    await this.prior;
    await adapter.sendText(this.chatId, finalText);
  }
  dispose() {
    this.finished = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
interface Tracked {
  runId: string;
  connectorId: string;
  chatId: string;
  botId: string;
  typingAt: number;
  /** The person spoke; the answer may be spoken back. */
  voice?: boolean;
  /** The currently streaming assistant message, if any. */
  active?: { messageId: string; stream: LiveMessageStream };
  /** Assistant messages already finalized and queued for delivery. */
  delivered: Set<string>;
  /** Keeps messages, streams and cards for this run in chronological order. */
  delivery: Promise<void>;
}
interface Prompt {
  requestId: string;
  runId: string;
  connectorId: string;
  chatId: string;
  code: string;
  kind: InteractionRequest['kind'];
  card?: ConnectorCard;
  handle?: string;
  /** For questions: answered by the person in this chat with their next message. */
  questions?: Array<{ id: string; title: string; options?: string[] }>;
  decided?: boolean;
}
const TICK_MS = 1000;
const TYPING_MS = 10_000;
const APPROVE = /^(同意|允许|批准|可以|ok|yes|y)\s*#?([a-z0-9]{4})?$/i;
const DENY = /^(拒绝|不同意|驳回|不行|no|n)\s*#?([a-z0-9]{4})?$/i;
/** Requests the owner allows or denies, by card button or text reply; each keyed by its card button prefix. */
const DECISIONS: Partial<Record<InteractionRequest['kind'], string>> = {
  host_permission: 'p',
  computer_use: 'c',
  vault_use: 'v',
};

/** Owners are reached in the chat they last wrote from, or by their ID where the platform accepts one. */
export const ownerChat = (connector: StoredConnector) => connector.owner?.chatId || connector.owner?.id;

export class ConnectorOutbox {
  private runs = new Map<string, Tracked>();
  private prompts = new Map<string, Prompt>();
  private timer?: ReturnType<typeof setInterval>;
  private botNames = (botId: string) => this.host.store.data.bots.find((bot) => bot.id === botId)?.name || 'Bot';
  constructor(private host: OutboxHost) {}

  /** The connector chat a run answers, when its input came from one. */
  private origin(botId: string, options: HarnessRunOptions) {
    if (!options.sessionId) return;
    const session = this.host.store.data.workSessions?.find(
      (item) => item.id === options.sessionId && item.botId === botId,
    );
    if (!session?.connector) return;
    const inputs =
      this.relayedInput(options) ||
      this.host.store.data.messages.filter((message) => options.inputMessageIds?.includes(message.id));
    if (!inputs.some((message) => message.connector || message.scheduled)) return;
    return {
      connectorId: session.connector.connectorId,
      chatId: session.connector.chatId,
      voice: inputs.some((message) => message.connector?.voice),
    };
  }
  /**
   * For the final reply to a private message to another Bot: the input of the run that sent it. The reply arrives
   * after that run ended, and goes to the chat that run was answering.
   */
  private relayedInput(options: HarnessRunOptions) {
    if (options.peerOrigin?.kind !== 'peer_summary') return;
    const store = this.host.store,
      exchange = store.data.peerExchanges.find((item) => item.id === options.peerOrigin!.exchangeId),
      root = store.data.runs.find((run) => run.id === exchange?.rootRunId && run.sessionId === options.sessionId),
      input = root ? store.humanRunMessage(root.id) : undefined;
    return input ? [input] : [];
  }
  /** Wraps one run started by the chat queue; untracked runs pass through unchanged. */
  wrapRun(botId: string, options: HarnessRunOptions, start: (options: HarnessRunOptions) => Promise<void>) {
    const origin = this.origin(botId, options);
    if (!origin) return start(options);
    let runId: string | undefined;
    return start({
      ...options,
      onStarted: (id) => {
        options.onStarted?.(id);
        runId = id;
        this.begin(id, botId, origin.connectorId, origin.chatId, origin.voice);
      },
      onAssistantStream: (event) => {
        options.onAssistantStream?.(event);
        this.stream(event.runId, event.messageId, event.content, event.reset);
      },
      onAssistantMessage: (event) => {
        options.onAssistantMessage?.(event);
        this.assistantMessage(event.runId, event.messageId, event.content, event.presentation);
      },
    }).finally(() => {
      if (runId) void this.complete(runId);
    });
  }
  private begin(runId: string, botId: string, connectorId: string, chatId: string, voice: boolean) {
    this.runs.set(runId, {
      runId,
      connectorId,
      chatId,
      botId,
      typingAt: 0,
      ...(voice ? { voice } : {}),
      delivered: new Set(),
      delivery: Promise.resolve(),
    });
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.tick();
  }
  private enqueue(tracked: Tracked, task: () => Promise<void>) {
    const next = tracked.delivery
      .catch(() => {})
      .then(task)
      .catch((error) =>
        this.host.journal('connector.reply-error', { runId: tracked.runId, error: (error as Error).message }),
      );
    tracked.delivery = next;
    return next;
  }
  /** Feeds live streaming assistant text to the platform's streaming handle, when supported. */
  private stream(runId: string, messageId: string, content: string, reset?: boolean) {
    const tracked = this.runs.get(runId);
    if (!tracked || tracked.delivered.has(messageId)) return;
    const text = reset ? '' : connectorStreamingText(content);
    if (tracked.active && tracked.active.messageId !== messageId) {
      const previous = tracked.active.stream;
      tracked.active = undefined;
      this.enqueue(tracked, () => previous.finish(''));
    }
    if (!tracked.active) {
      if (!text) return;
      const adapter = this.host.adapter(tracked.connectorId);
      if (!adapter?.beginStream) return;
      const stream = new LiveMessageStream(
        tracked.chatId,
        () => this.host.adapter(tracked.connectorId),
        tracked.delivery,
        (error) => this.host.journal('connector.stream-error', { runId, error: (error as Error).message }),
      );
      tracked.active = { messageId, stream };
    }
    tracked.active.stream.push(text);
  }
  /** Finalizes an intermediate assistant text turn immediately, before tools run or the next turn begins. */
  private assistantMessage(runId: string, messageId: string, content: string, presentation: 'progress' | 'answer') {
    if (presentation !== 'progress') return;
    const tracked = this.runs.get(runId);
    if (!tracked || tracked.delivered.has(messageId)) return;
    tracked.delivered.add(messageId);
    const text = connectorText(content);
    const active = tracked.active?.messageId === messageId ? tracked.active.stream : undefined;
    if (active) {
      tracked.active = undefined;
      this.enqueue(tracked, () => active.finish(text));
      return;
    }
    if (!text) return;
    this.enqueue(tracked, async () => {
      const adapter = this.host.adapter(tracked.connectorId);
      if (adapter) await adapter.sendText(tracked.chatId, text);
    });
  }
  /** Keeps the typing cue up while runs work; WeChat's expires, so it is sent again now and then. */
  private tick() {
    for (const tracked of this.runs.values()) {
      const adapter = this.host.adapter(tracked.connectorId);
      if (!adapter?.typing || Date.now() - tracked.typingAt < TYPING_MS) continue;
      tracked.typingAt = Date.now();
      void adapter.typing(tracked.chatId, true).catch(() => {});
    }
    if (!this.runs.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  private async complete(runId: string) {
    const tracked = this.runs.get(runId);
    if (!tracked) return;
    this.runs.delete(runId);
    for (const prompt of [...this.prompts.values()].filter((item) => item.runId === runId))
      await this.closePrompt(prompt, '已失效');
    await tracked.delivery.catch(() => {});
    const active = tracked.active;
    tracked.active = undefined;
    const adapter = this.host.adapter(tracked.connectorId);
    if (!adapter) {
      active?.stream.dispose();
      this.host.journal('connector.reply-skipped', { runId, connectorId: tracked.connectorId, reason: 'offline' });
      return;
    }
    const run = this.host.store.data.runs.find((item) => item.id === runId),
      // All of the run's messages: a final reply to a private message is published to the chat only after this.
      messages = this.host.store.runMessages(runId),
      answers = messages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.presentation === 'answer' &&
          (message.content.trim() || message.attachments?.length),
      );
    // Another run in this chat, one that took over after new input, keeps the cue.
    if (adapter.typing && ![...this.runs.values()].some((item) => item.chatId === tracked.chatId))
      await adapter.typing(tracked.chatId, false).catch(() => {});
    // A run stopped by new input is followed by the run that answers it; one the person stopped needs no reply.
    if (run?.status === 'cancelled') {
      if (active) await active.stream.finish('').catch(() => {});
      return;
    }
    if (run?.status === 'completed') {
      for (const message of messages) {
        if (
          message.role !== 'assistant' ||
          message.presentation !== 'progress' ||
          message.status !== 'done' ||
          tracked.delivered.has(message.id)
        )
          continue;
        tracked.delivered.add(message.id);
        const progress = connectorText(message.content);
        if (active?.messageId === message.id)
          await active.stream.finish(progress).catch((error) => {
            this.host.journal('connector.reply-error', { runId, error: (error as Error).message });
          });
        else if (progress)
          await adapter.sendText(tracked.chatId, progress).catch((error) => {
            this.host.journal('connector.reply-error', { runId, error: (error as Error).message });
          });
      }
    }
    // Blocks are app-only; a connector chat gets their plain-text fallbacks instead of placement markers.
    const answerText = answers
      // Charts and widgets are app-only; a chat gets what they say as text.
      .map((message) => connectorText(message.content))
      // An answer that is only files carries a placeholder line; the files speak for themselves.
      .filter((content, index) => content && !(content === '已附上文件。' && answers[index].attachments?.length))
      .join('\n\n');
    const text =
      run?.status === 'completed'
        ? [answerText, ...(run?.blocks || []).map((block) => block.fallback)].filter(Boolean).join('\n\n')
        : '这次没有完成：' + (run?.error || '出现了错误').slice(0, 500);
    try {
      const finalStream =
        run?.status === 'completed' && active && answers.some((message) => message.id === active.messageId)
          ? active.stream
          : undefined;
      if (finalStream) await finalStream.finish(text);
      else {
        if (active && !tracked.delivered.has(active.messageId)) await active.stream.finish('').catch(() => {});
        if (text) await adapter.sendText(tracked.chatId, text);
      }
    } catch (error) {
      this.host.journal('connector.reply-error', { runId, error: (error as Error).message });
    }
    const files = answers.flatMap((message) => message.attachments || []),
      spoken = new Set(run?.voiceAttachmentIds);
    // Spoken to, the Bot answers by voice as well; the text above stays for reading and searching. A Bot that
    // recorded a voice message of its own has answered by voice already.
    if (
      tracked.voice &&
      adapter.voiceFormat &&
      adapter.sendVoice &&
      run?.status === 'completed' &&
      answerText &&
      !files.some((file) => spoken.has(file.id))
    )
      try {
        const clips = await this.host.voice(
          tracked.botId,
          answerText,
          adapter.voiceFormat,
          AbortSignal.timeout(180_000),
        );
        for (const clip of clips || []) await adapter.sendVoice(tracked.chatId, clip);
      } catch (error) {
        this.host.journal('connector.voice-error', { runId, error: (error as Error).message });
      }
    for (const file of files) {
      if (spoken.has(file.id) && (await this.speak(adapter, tracked, file.id))) continue;
      try {
        await adapter.sendFile(tracked.chatId, { name: file.name, bytes: this.host.bytes(file.id) });
      } catch (error) {
        await adapter
          .sendText(tracked.chatId, `文件「${file.name}」没能发送（${(error as Error).message}），请在电脑上查看。`)
          .catch(() => {});
      }
    }
  }
  /**
   * Sends audio the Bot recorded as voice messages, where the platform takes them. False when it should go as a file
   * instead: the platform takes no voice, the audio is too long, or sending failed part of the way.
   */
  private async speak(adapter: ConnectorAdapter, tracked: Tracked, attachmentId: string) {
    if (!adapter.voiceFormat || !adapter.sendVoice) return false;
    try {
      const clips = await this.host.voiceClips(attachmentId, adapter.voiceFormat, AbortSignal.timeout(180_000));
      if (!clips?.length) return false;
      for (const clip of clips) await adapter.sendVoice(tracked.chatId, clip);
      return true;
    } catch (error) {
      this.host.journal('connector.voice-error', { runId: tracked.runId, error: (error as Error).message });
      return false;
    }
  }
  /** Sends new approval requests and questions of tracked runs, and closes the ones decided elsewhere. */
  interactionsChanged() {
    const pending = this.host.interactions.snapshot(),
      ids = new Set(pending.map((request) => request.id));
    for (const prompt of this.prompts.values())
      if (!ids.has(prompt.requestId)) void this.closePrompt(prompt, prompt.decided ? undefined : '已在电脑上处理');
    for (const request of pending) {
      const tracked = this.runs.get(request.runId);
      if (!tracked || this.prompts.has(request.id)) continue;
      // The approval model is still deciding; a person is asked only if it hands the request over.
      if (request.kind === 'host_permission' && request.approval?.phase === 'reviewing') continue;
      void this.ask(request, tracked);
    }
  }
  private async ask(request: InteractionRequest, tracked: Tracked) {
    const connector = this.host.connector(tracked.connectorId),
      adapter = this.host.adapter(tracked.connectorId);
    if (!connector || !adapter) return;
    const bot = this.botNames(tracked.botId),
      code = request.id
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 4)
        .toUpperCase();
    // Approvals and takeover prompts belong to the owner's private chat; questions go back to whoever asked.
    const chatId = request.kind === 'user_input' ? tracked.chatId : ownerChat(connector);
    if (!chatId) return;
    const prompt: Prompt = {
      requestId: request.id,
      runId: tracked.runId,
      connectorId: connector.id,
      chatId,
      code,
      kind: request.kind,
    };
    this.prompts.set(request.id, prompt);
    // Wait for any intermediate turn message that preceded this tool call to finalize first.
    await tracked.delivery.catch(() => {});
    if (!this.prompts.has(request.id) || prompt.decided) return;
    try {
      if (request.kind === 'host_permission' || request.kind === 'computer_use') {
        const prefix = DECISIONS[request.kind];
        prompt.card =
          request.kind === 'host_permission'
            ? {
                title: `${bot} 请求本机权限`,
                lines: permissionSummary(request.details),
                buttons: [
                  { label: '允许一次', key: `${prefix}:${code}:allow`, style: 'primary' },
                  { label: '拒绝', key: `${prefix}:${code}:deny`, style: 'danger' },
                ],
              }
            : {
                title: `${bot} 请求操控这台电脑`,
                lines: [
                  '允许后，它会在这次任务中操作这台电脑上的应用。能在后台完成的不打扰电脑前的人；用到鼠标和键盘时屏幕上会有提示。',
                  '提示出现时，在电脑前按 Esc 可以随时中止。',
                ],
                buttons: [
                  { label: '允许这次任务', key: `${prefix}:${code}:allow`, style: 'primary' },
                  { label: '拒绝', key: `${prefix}:${code}:deny`, style: 'danger' },
                ],
              };
        if (adapter.sendCard) prompt.handle = await adapter.sendCard(chatId, prompt.card);
        else
          await adapter.sendText(
            chatId,
            [
              prompt.card.title,
              ...prompt.card.lines,
              '',
              `回复「同意 ${code}」${request.kind === 'computer_use' ? '允许' : '允许一次'}，回复「拒绝 ${code}」拒绝。`,
            ].join('\n'),
          );
      } else if (request.kind === 'user_input') {
        prompt.questions = request.questions;
        const [only] = request.questions;
        if (request.questions.length === 1 && only.options?.length && adapter.sendCard) {
          prompt.card = {
            title: `${bot} 的问题`,
            lines: [only.title],
            buttons: only.options.map((option, index) => ({ label: option, key: `q:${code}:${index}` })),
          };
          prompt.handle = await adapter.sendCard(chatId, prompt.card);
        } else
          await adapter.sendText(
            chatId,
            [
              `${bot} 想问你：`,
              ...request.questions.map(
                (question, index) =>
                  `${request.questions.length > 1 ? `${index + 1}. ` : ''}${question.title}` +
                  (question.options?.length ? `（可选：${question.options.join(' / ')}）` : ''),
              ),
              '',
              request.questions.length > 1 ? '请按编号逐行回复答案。' : '直接回复答案即可。',
            ].join('\n'),
          );
      } else if (request.kind === 'vault_use') {
        const prefix = DECISIONS.vault_use;
        if (request.category === 'card' || !this.host.interactions.decideVaultUse) {
          prompt.decided = true;
          await adapter.sendText(
            chatId,
            [
              `${bot} 请求使用保险库条目「${request.itemTitle}」（${request.category}，字段：${request.fields.join(', ')}）`,
              `注入目标：${request.targetSummary}`,
              '出于安全要求，请前往桌面端或已配对手机 PWA 完成确认。',
            ].join('\n'),
          );
        } else {
          const lines = [
            `条目：${request.itemTitle}（${request.category}）`,
            `字段：${request.fields.join(', ')}`,
            `目标：${request.targetSummary}`,
            ...(request.bindingMismatch ? ['注意：当前目标与条目配置绑定不一致，请确认无误后放行。'] : []),
          ];
          const buttons = [
            { label: '允许一次', key: `${prefix}:${code}:allow`, style: 'primary' as const },
            ...(request.allowRunGrant ? [{ label: '本任务内允许', key: `${prefix}:${code}:allow-run` }] : []),
            { label: '拒绝', key: `${prefix}:${code}:deny`, style: 'danger' as const },
          ];
          prompt.card = { title: `${bot} 请求使用保险库凭据`, lines, buttons };
          if (adapter.sendCard) prompt.handle = await adapter.sendCard(chatId, prompt.card);
          else
            await adapter.sendText(
              chatId,
              [prompt.card.title, ...lines, '', `回复「同意 ${code}」允许一次，回复「拒绝 ${code}」拒绝。`].join('\n'),
            );
        }
      } else if (request.kind === 'vault_input') {
        prompt.decided = true;
        await adapter.sendText(
          chatId,
          [
            `${bot} 请求填写安全保险库条目「${request.title}」：${request.reason}`,
            '为避免明文进入聊天记录，请前往桌面端或已配对手机 PWA 填写并加密提交。',
          ].join('\n'),
        );
      } else {
        prompt.decided = true;
        await adapter.sendText(chatId, `${bot} 需要你在电脑前接管工作电脑：${request.reason}`);
      }
    } catch (error) {
      this.host.journal('connector.prompt-error', { requestId: request.id, error: (error as Error).message });
    }
  }
  private async closePrompt(prompt: Prompt, result?: string) {
    this.prompts.delete(prompt.requestId);
    if (!result || !prompt.card || !prompt.handle) return;
    const adapter = this.host.adapter(prompt.connectorId);
    await adapter?.closeCard?.(prompt.handle, prompt.card, result).catch(() => {});
  }
  private decide(prompt: Prompt, decision: 'allow' | 'allow-run' | 'deny') {
    prompt.decided = true;
    try {
      if (prompt.kind === 'vault_use') {
        this.host.interactions.decideVaultUse?.(prompt.requestId, decision);
        return decision === 'deny' ? '已拒绝' : decision === 'allow-run' ? '已本任务允许' : '已允许';
      }
      const allow = decision !== 'deny';
      if (prompt.kind === 'computer_use') this.host.interactions.decideComputerAccess(prompt.requestId, allow);
      else this.host.interactions.approve(prompt.requestId, allow);
      return allow ? '已允许' : '已拒绝';
    } catch {
      return '已失效';
    }
  }
  private respond(prompt: Prompt, answers: Record<string, string>) {
    prompt.decided = true;
    try {
      this.host.interactions.answer(prompt.requestId, answers);
      return '已回答';
    } catch (error) {
      prompt.decided = false;
      throw error;
    }
  }
  /** A card button: only the owner decides approvals, and only the asker answers a question. */
  async action(connector: StoredConnector, action: InboundAction) {
    const [kind, code, choice] = action.key.split(':');
    const prompt = [...this.prompts.values()].find(
      (item) => item.connectorId === connector.id && item.code === code && !item.decided,
    );
    if (!prompt) return '已失效';
    if (kind === DECISIONS[prompt.kind]) {
      if (action.operator.id !== connector.owner?.id) return undefined;
      const decision = choice === 'allow-run' ? 'allow-run' : choice === 'allow' ? 'allow' : 'deny';
      const result = this.decide(prompt, decision);
      if (prompt.handle && prompt.card) void this.closePrompt(prompt, result);
      return result;
    }
    if (kind === 'q' && prompt.kind === 'user_input' && prompt.questions?.length === 1) {
      if (action.chatId !== prompt.chatId && action.operator.id !== prompt.chatId) return undefined;
      const question = prompt.questions[0],
        option = question.options?.[Number(choice)];
      if (!option) return undefined;
      try {
        const result = this.respond(prompt, { [question.id]: option });
        if (prompt.handle && prompt.card) void this.closePrompt(prompt, `${result}：${option}`);
        return `${result}：${option}`;
      } catch {
        return '已失效';
      }
    }
    return undefined;
  }
  /** A text reply that answers a pending prompt in this chat; true when it was taken as one. */
  async reply(connector: StoredConnector, message: InboundMessage, adapter: ConnectorAdapter) {
    const text = message.text.trim();
    if (!text || text.startsWith('/')) return false;
    const open = [...this.prompts.values()].filter(
      (prompt) => prompt.connectorId === connector.id && prompt.chatId === message.chatId && !prompt.decided,
    );
    const approval = APPROVE.exec(text) || DENY.exec(text);
    if (approval && message.sender.id === connector.owner?.id) {
      const code = approval[2]?.toUpperCase(),
        permissions = open.filter((prompt) => DECISIONS[prompt.kind]),
        prompt = code
          ? permissions.find((item) => item.code === code)
          : permissions.length === 1
            ? permissions[0]
            : undefined;
      if (prompt) {
        const result = this.decide(prompt, APPROVE.test(text) ? 'allow' : 'deny');
        void this.closePrompt(prompt, result);
        await adapter.sendText(message.chatId, result + '。').catch(() => {});
        return true;
      }
      if (permissions.length > 1) {
        await adapter
          .sendText(
            message.chatId,
            `有 ${permissions.length} 个请求在等待，请带上编号回复，例如「同意 ${permissions[0].code}」。`,
          )
          .catch(() => {});
        return true;
      }
    }
    const question = open.filter((prompt) => prompt.kind === 'user_input').at(-1);
    if (!question?.questions) return false;
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^\s*\d+[.、)）]\s*/, '').trim())
      .filter(Boolean);
    const answers =
      question.questions.length === 1
        ? { [question.questions[0].id]: text }
        : lines.length === question.questions.length
          ? Object.fromEntries(question.questions.map((item, index) => [item.id, lines[index]]))
          : undefined;
    if (!answers) {
      await adapter
        .sendText(message.chatId, `请按编号逐行回复这 ${question.questions.length} 个问题。`)
        .catch(() => {});
      return true;
    }
    try {
      const result = this.respond(question, answers);
      void this.closePrompt(question, result);
      await adapter.sendText(message.chatId, result + '。').catch(() => {});
    } catch (error) {
      await adapter.sendText(message.chatId, (error as Error).message).catch(() => {});
    }
    return true;
  }
  dispose() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const tracked of this.runs.values()) tracked.active?.stream.dispose();
    this.runs.clear();
    this.prompts.clear();
  }
}
