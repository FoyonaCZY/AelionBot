import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CognitiveStore, normalizedFact } from './cognitive-store';
import { assertMemoryOwner, delegatedMemory, humanRunSource, memoryRoute, peerTaskUserSource } from './memory-routing';
import { AppError } from '../../../shared/errors';
import type { ChatMessage } from '../../../shared/types/core';
import { MEMORY_KINDS, type MemoryKind, type MemoryRef, type MemorySource } from '../../../shared/types/memory-types';
import { buildCore, coreBudget, coreDelta, type CoreBlock, recall, type RecallInput } from './memory-recall';
import { externalTool, judge, sensitivity } from './memory-policy';
import { botScope, groupScope, type MemoryContext, projectOf, USER_SCOPE, visibleScopes } from './memory-scope';
import { type MemoryStore, shortId, type StoredItem } from './memory-store';
import { similarity } from './memory-text';

export function knowledgeTextSafe(text: string, secrets: string[] = []) {
  if (
    /\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{20,})\b|BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(
      text,
    ) ||
    secrets.some((secret) => secret.length >= 6 && text.includes(secret))
  )
    throw new Error('不能将凭据保存为长期知识');
}
/** A record of one run's results is not long-term knowledge; it stays in the history. */
export function assertNotOneOff(text: string) {
  if (/(?:本次|这次|最近|已验证的|受控样例).{0,90}(?:\d+\s*项测试|测试通过|成功读回|生成了|合计)/s.test(text))
    throw new AppError(
      'memory.one_off_execution',
      '这是一次性执行记录，请改写为长期规则；测试数量与本次结果保留在历史中',
    );
}
export const sourceOf = (message: ChatMessage): MemorySource => ({
  messageId: message.id,
  role: message.role,
  ...(message.tool ? { tool: message.tool } : {}),
  botId: message.botId,
  at: message.time,
});
export type MemoryMode = 'on' | 'read' | 'off';
const MODES = new Set<MemoryMode>(['on', 'read', 'off']);
export interface WhereInput {
  sessionId?: string;
  groupId?: string;
  workspaceDir?: string;
  /** A private exchange between Bots, before it enters the Bot's main conversation. */
  peer?: boolean;
}
interface FrozenCore extends CoreBlock {
  epoch: number;
  at: string;
}
export class MemoryService {
  readonly items: MemoryStore;
  /** The person a connector belongs to. Without it, every message from a connector counts as someone else's. */
  connectorOwner?: (connectorId: string) => string | undefined;
  /** Called when memory changed, so views and the vector index can follow. */
  onChanged?: () => void;
  constructor(
    private storage: CognitiveStore,
    private secrets: () => string[] = () => [],
  ) {
    this.items = storage.items;
  }
  // Settings per Bot and per conversation

  /** Whether a Bot uses the facts about the user. A role-play character can be set apart. */
  sharesUser(botId: string) {
    return this.storage.get('memory-share-user:' + botId) !== 'false';
  }
  setSharesUser(botId: string, shared: boolean) {
    this.storage.set('memory-share-user:' + botId, String(shared));
    this.mirror(botId);
  }
  /** on: uses and learns. read: uses but does not learn. off: neither. A conversation's setting wins over its Bot's. */
  mode(botId: string, conversation?: string): MemoryMode {
    const specific = conversation ? this.storage.get('memory-mode:' + conversation) : undefined,
      value = specific || this.storage.get('memory-mode:bot:' + botId);
    return MODES.has(value as MemoryMode) ? (value as MemoryMode) : 'on';
  }
  setMode(key: string, mode: MemoryMode | null) {
    if (mode === null) this.storage.db.prepare('DELETE FROM meta WHERE key=?').run('memory-mode:' + key);
    else if (MODES.has(mode)) this.storage.set('memory-mode:' + key, mode);
  }
  // Who is speaking

  ownerMessage(message: ChatMessage) {
    if (!message.connector) return true;
    return this.connectorOwner?.(message.connector.connectorId) === message.connector.sender.id;
  }
  contextFor(botId: string, where: WhereInput = {}): MemoryContext {
    const session = where.sessionId
        ? this.storage.store.data.workSessions?.find((item) => item.id === where.sessionId)
        : undefined,
      connector = session?.connector,
      // Whoever spoke last decides, and anything said in a group chat is in front of everyone in it.
      last = connector
        ? this.storage.store.data.messages
            .filter((message) => message.sessionId === where.sessionId && message.role === 'user' && message.connector)
            .at(-1)
        : undefined,
      owner =
        !connector ||
        (last
          ? !last.connector!.isGroup && this.ownerMessage(last)
          : this.connectorOwner?.(connector.connectorId) === connector.peer.id),
      project = projectOf(where.workspaceDir);
    if (project) this.items.setLabel(project.scope, project.label, project.root);
    return {
      botId,
      channel: where.peer
        ? 'peer'
        : where.groupId
          ? 'group'
          : connector && !owner
            ? 'connector'
            : where.sessionId
              ? 'session'
              : 'main',
      ...(project ? { projectScope: project.scope } : {}),
      ...(where.groupId ? { groupId: where.groupId } : {}),
      shareUser: this.sharesUser(botId),
    };
  }
  // Reading

  private label = (scope: string) => this.items.label(scope);
  core(context: MemoryContext, contextTokens: number) {
    return buildCore(this.items, context, coreBudget(contextTokens), this.label);
  }
  /** The current facts as text, for a model request that is not bound to a context epoch. */
  prompt(botId: string, where: WhereInput = {}) {
    const context = this.contextFor(botId, where);
    return this.core(context, this.storage.store.modelFor(botId).contextTokens).text || '长期记忆：暂无';
  }
  /**
   * The core block of a context, unchanged until its next compaction, so a saved memory does not disturb the
   * prompt cache. What must not wait is sent with the next run as a delta.
   */
  frozenCore(stateKey: string, epoch: number, context: MemoryContext, contextTokens: number): FrozenCore {
    const saved = this.readFrozen(stateKey, context.botId);
    if (saved?.epoch === epoch) return saved;
    const next = { ...this.core(context, contextTokens), epoch, at: new Date().toISOString() };
    this.storage.contextState(context.botId, stateKey, 'memory-core', JSON.stringify(next));
    return next;
  }
  private readFrozen(stateKey: string, botId: string): FrozenCore | undefined {
    const raw = this.storage.contextState(botId, stateKey, 'memory-core');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as FrozenCore;
    } catch {
      return undefined;
    }
  }
  /**
   * What this run should know beyond the frozen core: corrections made since, and memories related to the request.
   * Each memory is brought up once per context epoch; after that it is already in the conversation.
   */
  turnMemory(
    stateKey: string,
    context: MemoryContext,
    input: Omit<RecallInput, 'exclude' | 'budget'> & { contextTokens: number },
  ): { text: string; recalled: MemoryRef[] } {
    const epoch = this.storage.head(stateKey).revision,
      frozen = this.frozenCore(stateKey, epoch, context, input.contextTokens);
    let seen: { epoch: number; ids: string[] } = { epoch, ids: [] };
    try {
      const raw = this.storage.contextState(context.botId, stateKey, 'memory-recalled');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.epoch === epoch) seen = parsed;
      }
    } catch {
      /* Forgetting what was recalled only repeats a line. */
    }
    const result = recall(this.items, context, {
      ...input,
      exclude: new Set([...frozen.ids, ...seen.ids]),
      budget: Math.max(150, Math.min(600, Math.floor(input.contextTokens * 0.015))),
    });
    const ids = result.items.map((item) => item.id);
    if (ids.length || result.episodes.length) {
      this.items.recalled(ids);
      this.storage.contextState(
        context.botId,
        stateKey,
        'memory-recalled',
        JSON.stringify({ epoch, ids: [...seen.ids, ...ids, ...result.episodes].slice(-300) }),
      );
    }
    return {
      text: coreDelta(this.items, frozen, context) + result.text,
      recalled: result.items,
    };
  }
  /** A run read content from outside; what it decides to remember may have been put there. */
  runTainted(runId: string) {
    return this.storage.store
      .runMessages(runId)
      .some((message) => message.role === 'tool' && message.status === 'done' && externalTool(message.tool));
  }
  // Writing, from the memory tool

  apply(
    botId: string,
    runId: string,
    args: {
      action: string;
      id?: string;
      content?: string;
      target?: string;
      kind?: string;
      oldContent?: string;
      validFrom?: string;
      validUntil?: string;
      sourceRefs?: string[];
    },
  ) {
    const store = this.storage.store;
    store.bot(botId);
    const run = store.data.runs.find((item) => item.id === runId),
      delegation = delegatedMemory(store, botId, runId),
      taskSource = peerTaskUserSource(store, botId, runId);
    if (run && run.botId !== botId) throw new Error('不能写入其他 Bot 的记忆');
    if (run?.peerOrigin && !taskSource)
      throw new AppError('memory.peer_source_unverified', '这次私聊没有转入已核验来源的主会话任务');
    const action = args.action,
      content = (args.content || '').trim();
    if (!['add', 'replace', 'remove'].includes(action)) throw new Error('记忆操作或内容无效');
    if ((action !== 'remove' && !content) || content.length > 600) throw new Error('记忆操作或内容无效');
    if (action === 'remove' && !content && !args.id && !args.oldContent) throw new Error('记忆操作或内容无效');
    knowledgeTextSafe(content, this.secrets());
    const refs = Array.isArray(args.sourceRefs)
      ? args.sourceRefs.map((ref) => this.storage.sourceMessage(botId, ref)?.id || ref)
      : [];
    if (delegation && !refs.includes(delegation.source.id)) refs.unshift(delegation.source.id);
    if (!refs.length && taskSource) refs.push(taskSource.id);
    if (!refs.length) {
      const source = humanRunSource(store, runId);
      if (source) refs.push(source.id);
    }
    const evidence: ChatMessage[] = [];
    for (const ref of refs) {
      const message = store.data.messages.find(
        (item) => item.id === ref && (item.botId === botId || taskSource?.id === ref),
      );
      if (!message) throw new Error('记忆来源无效');
      assertMemoryOwner(store, botId, message, delegation?.source.id === ref ? action : undefined);
      if (
        taskSource &&
        ((message.role !== 'user' && message.role !== 'tool') ||
          (args.target === 'user' && message.role !== 'user') ||
          (message.role === 'tool' && message.status !== 'done'))
      )
        throw new AppError('memory.provenance_invalid', '用户偏好必须来自用户消息，工作事实必须来自用户或成功工具证据');
      evidence.push(message);
    }
    const human = evidence.find((message) => message.role === 'user' && !message.scheduled),
      route = human ? memoryRoute(store, human) : undefined,
      explicit = Boolean(delegation || route?.actionsByBot[botId]?.length),
      owner = evidence.every((message) => this.ownerMessage(message)),
      tainted = this.runTainted(runId),
      where: WhereInput = {
        ...(run?.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run?.workspaceDir ? { workspaceDir: run.workspaceDir } : {}),
      },
      context = this.contextFor(botId, where),
      scopes = [...visibleScopes(context).scopes];
    const scope = this.targetScope(botId, args.target, context, Boolean(route?.namedBotIds.includes(botId)), owner);
    const change = { actor: 'bot' as const, runId };
    if (action !== 'add' && tainted && !explicit)
      throw new AppError('memory.needs_user', '这次对话读取过外部内容，修改或删除已有记忆需要用户明确要求');
    if (action !== 'add') {
      const match = this.findTarget(args.id, args.oldContent || content, scopes);
      if (action === 'remove') {
        this.items.forget(match.id, change);
        this.mirrorScope(match.scope, botId);
        return { saved: true, action, id: match.id };
      }
      return this.replaceItem(match, content, evidence, { explicit, owner, tainted, botId, runId, kind: args.kind });
    }
    const kind = this.kindOf(args.kind, args.target, Boolean(human));
    if (!explicit && this.items.tombstoned(scope, content))
      throw new AppError('memory.previously_deleted', '这条记忆曾被删除，不会自动重新保存');
    const peers = this.items.list({ scopes: [scope], statuses: ['active', 'candidate'] }),
      normalized = normalizedFact(content),
      duplicate = peers.find(
        (item) => normalizedFact(item.text) === normalized || similarity(item.text, content) >= 0.85,
      );
    if (duplicate) {
      this.items.update(duplicate.id, { confirmations: duplicate.confirmations + 1 }, 'confirm', change);
      return { saved: false, duplicate: true, id: duplicate.id };
    }
    const verdict = judge({ kind, scope, evidence, explicit, owner, tainted });
    if (!verdict)
      throw new AppError('memory.provenance_invalid', '用户偏好必须来自用户消息，工作事实必须来自用户或成功工具证据');
    const item = this.items.create(
      {
        scope,
        kind,
        text: content,
        origin: verdict.origin,
        status: verdict.active ? 'active' : 'candidate',
        sensitivity: sensitivity(content),
        authorBot: botId,
        ...(verdict.note ? { note: verdict.note } : {}),
        ...(validDate(args.validFrom) ? { validFrom: validDate(args.validFrom) } : {}),
        ...(validDate(args.validUntil) ? { validUntil: validDate(args.validUntil) } : {}),
        ...(verdict.origin === 'tool_verified' ? { verifiedAt: new Date().toISOString() } : {}),
        sources: evidence.map(sourceOf),
      },
      change,
    );
    this.mirrorScope(scope, botId);
    return {
      saved: true,
      action,
      id: item.id,
      ref: '#' + shortId(item.id),
      text: item.text,
      scope,
      ...(verdict.active ? {} : { pending: true, note: verdict.note }),
    };
  }
  private kindOf(kind: unknown, target: unknown, person: boolean): MemoryKind {
    if (MEMORY_KINDS.includes(kind as MemoryKind)) return kind as MemoryKind;
    // Without a person behind it, a fact cannot be a rule about how to behave.
    if (!person) return 'project';
    return target === 'user' ? 'preference' : target === 'project' ? 'project' : 'lesson';
  }
  /** Who a saved fact is about decides where it goes; what a Bot was told about itself stays its own. */
  private targetScope(botId: string, target: unknown, context: MemoryContext, named: boolean, owner: boolean) {
    if (named) return botScope(botId);
    if (target === 'project' && context.projectScope) return context.projectScope;
    if (target === 'group' && context.groupId) return groupScope(context.groupId);
    if (target === 'user' && owner && context.shareUser) return USER_SCOPE;
    return botScope(botId);
  }
  private findTarget(id: string | undefined, text: string, scopes: string[]) {
    if (id) {
      const item = this.items.resolve(id, scopes);
      if (!item) throw new AppError('memory.not_found', '没有找到要更新的记忆');
      return item;
    }
    const facts = this.items.list({ scopes, statuses: ['active', 'candidate'] }),
      exact = facts.filter((fact) => fact.text === text),
      matches = exact.length ? exact : facts.filter((fact) => fact.text.includes(text));
    if (matches.length !== 1)
      throw new AppError(
        matches.length ? 'memory.ambiguous' : 'memory.not_found',
        matches.length ? '匹配到多条记忆，请使用 #id 或准确的原文' : '没有找到要更新的记忆',
      );
    return matches[0];
  }
  private replaceItem(
    match: StoredItem,
    content: string,
    evidence: ChatMessage[],
    how: { explicit: boolean; owner: boolean; tainted: boolean; botId: string; runId: string; kind?: string },
  ) {
    const change = { actor: 'bot' as const, runId: how.runId },
      kind = MEMORY_KINDS.includes(how.kind as MemoryKind) ? (how.kind as MemoryKind) : match.kind,
      verdict = judge({
        kind,
        scope: match.scope,
        evidence,
        explicit: how.explicit,
        owner: how.owner,
        tainted: how.tainted,
      });
    if (!verdict)
      throw new AppError('memory.provenance_invalid', '用户偏好必须来自用户消息，工作事实必须来自用户或成功工具证据');
    if (!verdict.active) throw new AppError('memory.needs_user', verdict.note || '修改这条记忆需要用户确认');
    // Replacing a fact with text another fact already holds merges the two instead of storing it twice.
    const normalized = normalizedFact(content),
      duplicate = this.items
        .list({ scopes: [match.scope], statuses: ['active'] })
        .find((item) => item.id !== match.id && normalizedFact(item.text) === normalized);
    if (duplicate) {
      this.items.update(match.id, { status: 'superseded', supersededBy: duplicate.id }, 'merge', change);
      this.mirrorScope(match.scope, how.botId);
      return { saved: true, action: 'replace', id: duplicate.id, merged: true };
    }
    const next = this.items.supersede(
      match.id,
      {
        scope: match.scope,
        kind,
        text: content,
        origin: verdict.origin,
        sensitivity: sensitivity(content),
        authorBot: how.botId,
        cues: match.cues,
        entities: match.entities,
        sources: evidence.map(sourceOf),
      },
      change,
    );
    this.mirrorScope(match.scope, how.botId);
    return {
      saved: true,
      action: 'replace',
      id: next.id,
      ref: '#' + shortId(next.id),
      text: next.text,
      scope: match.scope,
    };
  }
  // The readable projection

  /** Every Bot's copy, when a fact about the user changed; otherwise the Bot it belongs to. */
  mirrorScope(scope: string, botId?: string) {
    if (scope === USER_SCOPE) for (const bot of this.storage.store.data.bots) this.mirror(bot.id);
    else if (scope.startsWith('bot:')) this.mirror(scope.slice(4));
    else if (botId) this.mirror(botId);
    this.onChanged?.();
  }
  /**
   * Writes the Markdown files under the Bot's folder, and `bot.memories`: what is left of the older copy in
   * state.json, read by the context of a private exchange between Bots, which never sees facts about the user.
   */
  mirror(botId: string) {
    const bot = this.storage.store.bot(botId),
      own = this.items.list({ scopes: [botScope(botId)], statuses: ['active'] }),
      user = this.sharesUser(botId) ? this.items.list({ scopes: [USER_SCOPE], statuses: ['active'] }) : [],
      texts = own
        .filter((item) => item.sensitivity === 'normal')
        .slice(-40)
        .map((item) => item.text);
    if (JSON.stringify(bot.memories) !== JSON.stringify(texts)) {
      bot.memories = texts;
      this.storage.store.save();
    }
    const dir = join(this.storage.store.dir, 'bots', botId, 'memories');
    mkdirSync(dir, { recursive: true });
    for (const [name, items] of [
      ['MEMORY.md', own],
      ['USER.md', user],
    ] as const) {
      const path = join(dir, name),
        temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, items.map((item) => `- ${item.text}`).join('\n') + '\n');
      renameSync(temp, path);
    }
  }
}
export const validDate = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};
