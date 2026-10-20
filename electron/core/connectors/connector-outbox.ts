// Replies from the Bot back to connector chats: only the final answer with its files, plus approval cards for the
// connector's owner and questions for whoever asked. While the Bot works the chat shows the platform's typing cue.
// Only runs started by connector messages, or by scheduled tasks in connector sessions, are sent; work started in
// the app stays in the app.
import type { InteractionRequest } from '../../../shared/types/core';
import type { HarnessRunOptions } from '../agent/peer-runtime-types';
import type { Store } from '../storage/store';
import type { ConnectorAdapter, ConnectorCard, InboundAction, InboundMessage } from './connector-adapter';
import type { StoredConnector } from './connector-store';
import { permissionSummary } from './format';
import { stripBlockMarkers } from '../../../shared/chat/message-blocks';

export interface OutboxHost {
  store: Store;
  connector(id: string): StoredConnector | undefined;
  /** The adapter of a running connector. */
  adapter(id: string): ConnectorAdapter | undefined;
  bytes(attachmentId: string): Buffer;
  interactions: {
    snapshot(): InteractionRequest[];
    approve(id: string, allow: boolean): void;
    answer(id: string, value: unknown): void;
  };
  journal(type: string, payload: unknown): void;
}
interface Tracked {
  runId: string;
  connectorId: string;
  chatId: string;
  botId: string;
  typingAt: number;
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
    return { connectorId: session.connector.connectorId, chatId: session.connector.chatId };
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
        this.begin(id, botId, origin.connectorId, origin.chatId);
      },
    }).finally(() => {
      if (runId) void this.complete(runId);
    });
  }
  private begin(runId: string, botId: string, connectorId: string, chatId: string) {
    this.runs.set(runId, { runId, connectorId, chatId, botId, typingAt: 0 });
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.tick();
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
    const adapter = this.host.adapter(tracked.connectorId);
    if (!adapter) {
      this.host.journal('connector.reply-skipped', { runId, connectorId: tracked.connectorId, reason: 'offline' });
      return;
    }
    const run = this.host.store.data.runs.find((item) => item.id === runId),
      // All of the run's messages: a final reply to a private message is published to the chat only after this.
      answers = this.host.store
        .runMessages(runId)
        .filter(
          (message) =>
            message.role === 'assistant' &&
            message.presentation === 'answer' &&
            (message.content.trim() || message.attachments?.length),
        );
    // Another run in this chat, one that took over after new input, keeps the cue.
    if (adapter.typing && ![...this.runs.values()].some((item) => item.chatId === tracked.chatId))
      await adapter.typing(tracked.chatId, false).catch(() => {});
    // A run stopped by new input is followed by the run that answers it; one the person stopped needs no reply.
    if (run?.status === 'cancelled') return;
    // Blocks are app-only; a connector chat gets their plain-text fallbacks instead of placement markers.
    const answerText = answers
      .map((message) => stripBlockMarkers(message.content))
      // An answer that is only files carries a placeholder line; the files speak for themselves.
      .filter((content, index) => content && !(content === '已附上文件。' && answers[index].attachments?.length))
      .join('\n\n');
    const text =
      run?.status === 'completed'
        ? [answerText, ...(run?.blocks || []).map((block) => block.fallback)].filter(Boolean).join('\n\n')
        : '这次没有完成：' + (run?.error || '出现了错误').slice(0, 500);
    try {
      if (text) await adapter.sendText(tracked.chatId, text);
    } catch (error) {
      this.host.journal('connector.reply-error', { runId, error: (error as Error).message });
    }
    for (const file of answers.flatMap((message) => message.attachments || [])) {
      try {
        await adapter.sendFile(tracked.chatId, { name: file.name, bytes: this.host.bytes(file.id) });
      } catch (error) {
        await adapter
          .sendText(tracked.chatId, `文件「${file.name}」没能发送（${(error as Error).message}），请在电脑上查看。`)
          .catch(() => {});
      }
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
    try {
      if (request.kind === 'host_permission') {
        prompt.card = {
          title: `${bot} 请求本机权限`,
          lines: permissionSummary(request.details),
          buttons: [
            { label: '允许一次', key: `p:${code}:allow`, style: 'primary' },
            { label: '拒绝', key: `p:${code}:deny`, style: 'danger' },
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
              `回复「同意 ${code}」允许一次，回复「拒绝 ${code}」拒绝。`,
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
      } else {
        prompt.decided = true;
        await adapter.sendText(
          chatId,
          request.kind === 'vm_takeover'
            ? `${bot} 需要你在电脑前接管工作电脑：${request.reason}`
            : `${bot} 想操作这台电脑的屏幕，需要你在电脑前确认。`,
        );
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
  private decide(prompt: Prompt, allow: boolean) {
    prompt.decided = true;
    try {
      this.host.interactions.approve(prompt.requestId, allow);
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
    if (kind === 'p' && prompt.kind === 'host_permission') {
      if (action.operator.id !== connector.owner?.id) return undefined;
      const result = this.decide(prompt, choice === 'allow');
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
        permissions = open.filter((prompt) => prompt.kind === 'host_permission'),
        prompt = code
          ? permissions.find((item) => item.code === code)
          : permissions.length === 1
            ? permissions[0]
            : undefined;
      if (prompt) {
        const result = this.decide(prompt, APPROVE.test(text));
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
    this.runs.clear();
    this.prompts.clear();
  }
}
