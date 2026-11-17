// Things done with whole conversations rather than inside one: searching all of them, and saving one as a file.
import { AppError } from '../../../shared/errors';
import { translateFor } from '../../../shared/i18n';
import {
  conversationExportName,
  exportBotConversation,
  exportGroupConversation,
} from '../../../shared/chat/conversation-export';
import {
  CONVERSATION_SEARCH_MAX,
  CONVERSATION_SEARCH_PAGE,
  scanConversations,
  type ConversationSearchResult,
} from '../../../shared/chat/conversation-search';
import type { AttachmentScope } from '../../../shared/types/attachment-types';
import { isPrivatePeerOrigin } from '../../../shared/types/peer-types';
import type { Store } from '../storage/store';

/** How long a search holds the main thread before it lets other work run. */
const SLICE_MS = 8;

/**
 * Search over every chat's stored messages. A large history is scanned in short slices so the app stays
 * responsive, and a newer search ends the one before it: only the latest answer is still wanted.
 */
export class ConversationSearch {
  private latest = 0;
  constructor(private readonly store: Store) {}
  async search(input: { query?: unknown; limit?: unknown }): Promise<ConversationSearchResult> {
    const query = typeof input?.query === 'string' ? input.query.slice(0, 200) : '',
      limit = Math.min(
        CONVERSATION_SEARCH_MAX,
        Math.max(1, Math.floor(Number(input?.limit)) || CONVERSATION_SEARCH_PAGE),
      ),
      mine = ++this.latest,
      data = this.store.data;
    // The lists are copied so messages arriving between slices do not move what is being read.
    const scan = scanConversations(
      {
        bots: data.bots,
        sessionIds: new Set(data.workSessions?.map((session) => session.id)),
        messages: data.messages.slice(),
        runs: data.runs,
        groups: data.groups.map((room) => ({ id: room.id, messages: room.messages.slice() })),
      },
      query,
      limit,
    );
    let until = performance.now() + SLICE_MS;
    for (;;) {
      const step = scan.next();
      if (step.done) return step.value;
      if (performance.now() < until) continue;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mine !== this.latest) return { hits: [], total: 0 };
      until = performance.now() + SLICE_MS;
    }
  }
}

/** A chat as a Markdown document with the file name to offer for it. */
export function conversationMarkdown(
  store: Store,
  scope: AttachmentScope | undefined,
  options: { steps?: boolean; exportedAt?: string } = {},
) {
  const exportedAt = options.exportedAt || new Date().toISOString(),
    // The interface language, so the document's labels read like the app does.
    t = (text: string, values?: Record<string, string | number>) =>
      translateFor(store.data.language || 'zh-CN', text, values),
    userName = store.data.userProfile?.displayName?.trim() || t('你'),
    botName = (id: string) => store.data.bots.find((bot) => bot.id === id)?.name;
  let title: string, text: string;
  if (scope?.kind === 'group') {
    const room = store.data.groups.find((item) => item.id === scope.id);
    if (!room) throw new AppError('group.not_found', '群聊不存在或已删除');
    title = room.name;
    text = exportGroupConversation(
      {
        messages: room.messages,
        members: room.members.filter((member) => !member.leftAt).map((member) => botName(member.id) || member.name),
        botName,
      },
      { title, userName, exportedAt, steps: options.steps, translate: t },
    );
  } else if (scope?.kind === 'bot') {
    const bot = store.bot(String(scope.id)),
      session = scope.sessionId ? store.data.workSessions?.find((item) => item.id === scope.sessionId) : undefined;
    if (scope.sessionId && session?.botId !== bot.id) throw new AppError('session.not_found', '工作会话不存在');
    const privateRuns = new Set(
      store.data.runs.filter((run) => isPrivatePeerOrigin(run.peerOrigin)).map((run) => run.id),
    );
    title = session ? `${bot.name} · ${session.name}` : bot.name;
    text = exportBotConversation(
      {
        botName: bot.name,
        // The same messages the chat shows: this chat's, without the Bot's private exchanges with other Bots.
        messages: store.data.messages.filter(
          (message) =>
            message.botId === bot.id &&
            message.sessionId === session?.id &&
            (message.audience === 'user' || !message.runId || !privateRuns.has(message.runId)),
        ),
        runs: store.data.runs,
      },
      { title, userName, exportedAt, steps: options.steps, translate: t },
    );
  } else throw new AppError('chat.export_scope_invalid', '无效的对话');
  return { name: conversationExportName(title, exportedAt), text };
}
