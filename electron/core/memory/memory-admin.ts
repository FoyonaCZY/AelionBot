import { AppError } from '../../../shared/errors';
import {
  MEMORY_KINDS,
  type MemoryEpisode,
  type MemoryItemDetail,
  type MemoryKind,
  type MemoryListQuery,
  type MemoryOverview,
  type MemoryScopeView,
  type MemoryUpdateInput,
} from '../../../shared/types/memory-types';
import type { Cognition } from './cognition';
import type { LocalEmbedder } from './memory-embedder';
import { sensitivity } from './memory-policy';
import { knowledgeTextSafe, type MemoryMode, validDate } from './memory-service';
import { botScope, USER_SCOPE } from './memory-scope';
import { type StoredItem } from './memory-store';
import { queryTokens } from './memory-text';

const change = { actor: 'user' as const };
const DAY = 86400000;
/** What the settings page does with memory. Everything here is the user's own decision and takes effect at once. */
export class MemoryAdmin {
  embedder?: LocalEmbedder;
  constructor(
    private cognition: Cognition,
    private secrets: () => string[] = () => [],
  ) {}
  private get items() {
    return this.cognition.storage.items;
  }
  private get store() {
    return this.cognition.store;
  }
  private get memory() {
    return this.cognition.memory;
  }
  private scopeLabel(scope: string) {
    if (scope === USER_SCOPE) return '关于你';
    if (scope.startsWith('bot:')) return this.store.data.bots.find((bot) => bot.id === scope.slice(4))?.name || 'Bot';
    if (scope.startsWith('group:'))
      return this.store.data.groups.find((group) => group.id === scope.slice(6))?.name || '群聊';
    return this.items.label(scope) || '项目';
  }
  overview(): MemoryOverview {
    const inUse = new Map(this.items.scopesInUse().map((entry) => [entry.scope, entry.count])),
      scopes: MemoryScopeView[] = [
        { scope: USER_SCOPE, kind: 'user', label: this.scopeLabel(USER_SCOPE), count: inUse.get(USER_SCOPE) || 0 },
        ...this.store.data.bots.map((bot) => ({
          scope: botScope(bot.id),
          kind: 'bot' as const,
          label: bot.name,
          botId: bot.id,
          count: inUse.get(botScope(bot.id)) || 0,
        })),
      ];
    for (const [scope, count] of inUse) {
      if (scope.startsWith('project:')) scopes.push({ scope, kind: 'project', label: this.scopeLabel(scope), count });
      if (scope.startsWith('group:')) scopes.push({ scope, kind: 'group', label: this.scopeLabel(scope), count });
    }
    const since = new Date(Date.now() - 7 * DAY).toISOString(),
      week = this.items.jobs(500, since),
      tally = (kind: string): [number, number] => [
        week.filter((job) => job.kind === kind && job.status === 'completed').length,
        week.filter((job) => job.kind === kind && job.status === 'failed').length,
      ];
    const vectors = this.cognition.vectors?.counts() || { indexed: 0, pending: 0 };
    return {
      scopes,
      pending: this.items.pending().length,
      jobs: this.items.jobs(30),
      totals: {
        capture: tally('capture'),
        consolidate: tally('consolidate'),
        tokens: week.reduce((sum, job) => sum + (job.inputTokens || 0) + (job.outputTokens || 0), 0),
      },
      embedding: this.embedder?.view(vectors) || {
        state: 'off',
        model: '',
        sizeMB: 0,
        indexed: 0,
        pending: 0,
      },
      isolatedBots: this.store.data.bots.filter((bot) => !this.memory.sharesUser(bot.id)).map((bot) => bot.id),
      ...(this.store.data.memoryModel ? { memoryModel: this.store.data.memoryModel } : {}),
    };
  }
  list(query: MemoryListQuery = {}): StoredItem[] {
    const limit = Math.max(1, Math.min(500, query.limit || 300));
    let items: StoredItem[];
    if (query.status === 'pending') items = this.items.pending();
    else
      items = this.items.list({
        ...(query.scope ? { scopes: [query.scope] } : {}),
        statuses: query.status === 'all' || !query.status ? ['active', 'candidate', 'archived'] : [query.status],
      });
    const text = query.query?.trim();
    if (text) {
      const owners = new Set(
        this.items
          .searchIndex(queryTokens(text), [...new Set(items.map((item) => item.scope))], ['item'], 500)
          .map((hit) => hit.owner),
      );
      items = items.filter((item) => owners.has(item.id) || item.text.includes(text));
    }
    return items
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, limit);
  }
  detail(id: string): MemoryItemDetail {
    const item = this.require(id),
      messages = this.store.data.messages;
    return {
      item,
      history: this.items.events({ itemId: id, limit: 30 }),
      sources: item.sources.map((source) => {
        const message = source.messageId ? messages.find((entry) => entry.id === source.messageId) : undefined;
        return {
          ...source,
          available: Boolean(message),
          ...(message
            ? {
                excerpt:
                  message.role === 'tool'
                    ? message.activity?.detail || message.tool || ''
                    : message.content.slice(0, 300),
                ...(message.sessionId ? { sessionId: message.sessionId } : {}),
                botId: message.botId,
              }
            : {}),
        };
      }),
    };
  }
  private require(id: string) {
    const item = this.items.get(String(id));
    if (!item || item.status === 'deleted') throw new AppError('memory.not_found', '这条记忆已不存在');
    return item;
  }
  private assertScope(scope: string) {
    const known =
      scope === USER_SCOPE ||
      (scope.startsWith('bot:') && this.store.data.bots.some((bot) => bot.id === scope.slice(4))) ||
      (scope.startsWith('group:') && this.store.data.groups.some((group) => group.id === scope.slice(6))) ||
      (scope.startsWith('project:') && Boolean(this.items.label(scope)));
    if (!known) throw new AppError('memory.scope_denied', '这个记忆范围不存在');
  }
  /** What the user writes here is what they said: it is trusted as if they had asked to remember it. */
  update(input: MemoryUpdateInput) {
    const item = this.require(input.id),
      patch: Partial<StoredItem> = {};
    if (typeof input.text === 'string' && input.text.trim() !== item.text) {
      const text = input.text.trim();
      if (!text || text.length > 600) throw new AppError('memory.invalid_text', '记忆内容不能为空，也不能超过 600 字');
      knowledgeTextSafe(text, this.secrets());
      Object.assign(patch, { text, origin: 'user_explicit', confidence: 1, sensitivity: sensitivity(text) });
    }
    if (input.kind && MEMORY_KINDS.includes(input.kind as MemoryKind)) patch.kind = input.kind as MemoryKind;
    if (typeof input.pinned === 'boolean') patch.pinned = input.pinned;
    if (input.validUntil !== undefined) patch.validUntil = validDate(input.validUntil) ?? undefined;
    if (input.scope && input.scope !== item.scope) {
      this.assertScope(input.scope);
      patch.scope = input.scope;
      patch.suggest = undefined;
      this.items.dropVectors(item.id);
    }
    const saved = this.items.update(item.id, patch, 'edit', change);
    this.memory.mirrorScope(item.scope);
    if (patch.scope) this.memory.mirrorScope(patch.scope);
    return saved;
  }
  /** Removes its text everywhere it is kept. A later attempt to learn it again is refused. */
  forget(id: string) {
    const item = this.require(id);
    this.items.forget(item.id, change);
    this.memory.mirrorScope(item.scope);
  }
  /** Accepts what waits for the user: a candidate into use, a suggested move carried out. */
  confirm(id: string) {
    const item = this.require(id),
      target = item.suggest?.scope;
    if (target) this.assertScope(target);
    const saved = this.items.update(
      item.id,
      {
        status: item.status === 'candidate' ? 'active' : item.status,
        note: undefined,
        suggest: undefined,
        ...(target ? { scope: target } : {}),
      },
      'confirm-user',
      change,
    );
    if (target) this.items.dropVectors(item.id);
    this.memory.mirrorScope(item.scope);
    if (target) this.memory.mirrorScope(target);
    return saved;
  }
  /** Declining a candidate forgets it; declining a move leaves the fact where it is. */
  reject(id: string) {
    const item = this.require(id);
    if (item.status === 'candidate') return this.forget(item.id);
    this.items.update(item.id, { suggest: undefined }, 'decline', change);
    this.memory.onChanged?.();
  }
  timeline(query: { botId?: string; before?: string; limit?: number }): MemoryEpisode[] {
    return this.items.episodes({
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.before ? { before: query.before } : {}),
      limit: Math.max(1, Math.min(100, query.limit || 40)),
    });
  }
  undoJob(jobId: string) {
    const result = this.items.undoJob(String(jobId), change);
    for (const bot of this.store.data.bots) this.memory.mirror(bot.id);
    this.memory.onChanged?.();
    return result;
  }
  setBotOptions(input: { botId: string; shareUser?: boolean; mode?: MemoryMode }) {
    this.store.bot(input.botId);
    if (typeof input.shareUser === 'boolean') this.memory.setSharesUser(input.botId, input.shareUser);
    if (input.mode) this.memory.setMode('bot:' + input.botId, input.mode);
  }
  /** What reading the existing conversations would take, for the user to decide first. */
  pastEstimate() {
    const conversations = this.cognition.capture.pastConversations();
    return {
      conversations: conversations.length,
      inputTokens: conversations.reduce((sum, entry) => sum + entry.tokens, 0),
    };
  }
  readPast() {
    this.cognition.worker.readPast(this.cognition.capture.pastConversations().map((entry) => entry.conversation));
  }
  exportData() {
    return JSON.stringify(
      {
        format: 'aelion-memories',
        version: 1,
        exportedAt: new Date().toISOString(),
        items: this.items
          .list({ statuses: ['active', 'archived'] })
          .map(({ id: _id, coreRank: _rank, suggest: _suggest, sources: _sources, ...item }) => ({
            ...item,
            scopeLabel: this.scopeLabel(item.scope),
          })),
      },
      null,
      2,
    );
  }
  /** Imported facts did not come from this app's conversations, so each waits for the user's confirmation. */
  importData(text: string, scope: string) {
    this.assertScope(scope);
    let parsed: { format?: unknown; items?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError('memory.import_invalid', '这不是有效的记忆文件');
    }
    if (parsed.format !== 'aelion-memories' || !Array.isArray(parsed.items))
      throw new AppError('memory.import_invalid', '这不是有效的记忆文件');
    let added = 0;
    this.items.transaction(() => {
      for (const entry of parsed.items as Array<Record<string, unknown>>) {
        const value = typeof entry?.text === 'string' ? entry.text.trim() : '';
        if (!value || value.length > 600) continue;
        try {
          knowledgeTextSafe(value, this.secrets());
        } catch {
          continue;
        }
        this.items.create(
          {
            scope,
            kind: MEMORY_KINDS.includes(entry.kind as MemoryKind) ? (entry.kind as MemoryKind) : 'project',
            text: value,
            origin: 'model_inferred',
            status: 'candidate',
            sensitivity: sensitivity(value),
            note: '从文件导入，确认后才会使用',
          },
          change,
        );
        added++;
      }
    });
    this.memory.onChanged?.();
    return { added };
  }
}
