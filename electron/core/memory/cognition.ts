import type { WireMessage } from '../../../shared/types/core';
import type { MemoryRef } from '../../../shared/types/memory-types';
import type { Store } from '../storage/store';
import type { ModelClient, ToolDefinition } from '../model/model';
import type { SkillLibrary } from '../extensions/skill-library';
import { CognitiveStore } from './cognitive-store';
import { MemoryService, knowledgeTextSafe, type WhereInput } from './memory-service';
import { ContextEngine } from '../context/context-engine';
import { LearningWorker, shouldReview, type ReviewPayload } from './learning-worker';
import { memoryRoute, routingOnlyRun } from './memory-routing';
import { MemoryCapture, type ModelAccess } from './memory-capture';
import { MemoryConsolidator } from './memory-consolidate';
import { type Embedder, MemoryVectors } from './memory-embedder';
import { conversationKey, visibleScopes } from './memory-scope';
import { shortId } from './memory-store';
import { MemoryWorker, type MemoryWorkerOptions } from './memory-worker';
import { queryTokens } from './memory-text';

export interface CognitionOptions extends MemoryWorkerOptions {
  /** The model memory's background work uses, when one is chosen for it; each Bot's own otherwise. */
  memoryModel?: ModelAccess;
}
export class Cognition {
  readonly storage: CognitiveStore;
  readonly memory: MemoryService;
  readonly context: ContextEngine;
  readonly learning: LearningWorker;
  readonly capture: MemoryCapture;
  readonly worker: MemoryWorker;
  readonly consolidator: MemoryConsolidator;
  vectors?: MemoryVectors;
  /** Reports how long afterRun took on the main thread, for slow-operation diagnostics. */
  onSlow?: (source: string, ms: number) => void;
  private closing = false;
  constructor(
    readonly store: Store,
    model: ModelClient,
    readonly skills: SkillLibrary,
    private changed: () => void,
    foregroundBusy: () => boolean,
    private secrets: () => string[] = () => [],
    settleMs = 2500,
    options: CognitionOptions = {},
  ) {
    this.storage = new CognitiveStore(store);
    this.memory = new MemoryService(this.storage, secrets);
    this.context = new ContextEngine(this.storage, model, changed);
    this.learning = new LearningWorker(
      this.storage,
      skills,
      model,
      this.context,
      changed,
      foregroundBusy,
      secrets,
      settleMs,
    );
    const access: ModelAccess = (botId) => options.memoryModel?.(botId);
    this.capture = new MemoryCapture(this.storage, this.memory, model, access, secrets);
    this.consolidator = new MemoryConsolidator(this.storage, this.memory, model, access, secrets);
    this.worker = new MemoryWorker(
      this.storage,
      this.memory,
      this.capture,
      this.consolidator,
      () => this.learning.enabled(),
      foregroundBusy,
      changed,
      (botId, worthy) => {
        this.storage.releaseReviews(botId, worthy);
        if (worthy) this.learning.schedule();
      },
      options,
    );
    for (const bot of store.data.bots) this.memory.mirror(bot.id);
  }
  useEmbedder(embedder: Embedder) {
    this.vectors = this.worker.vectors = new MemoryVectors(this.storage, embedder);
  }
  start() {
    this.learning.start();
    this.worker.start();
  }
  beforeRun() {
    this.learning.preempt();
    this.worker.preempt();
  }
  /** Any finished run, in any conversation: what it said is read for memory once the conversation goes quiet. */
  noteRun(botId: string, runId: string) {
    if (this.closing) return;
    const run = this.store.data.runs.find((item) => item.id === runId && item.botId === botId);
    if (run && !run.retracted) this.worker.note(run);
  }
  afterRun(botId: string, runId: string, messages: WireMessage[] | undefined, tools: ToolDefinition[]) {
    if (this.closing) return;
    const started = performance.now();
    try {
      this.indexAndQueueReview(botId, runId, messages, tools);
    } finally {
      this.onSlow?.('after-run', performance.now() - started);
    }
  }
  private indexAndQueueReview(
    botId: string,
    runId: string,
    messages: WireMessage[] | undefined,
    tools: ToolDefinition[],
  ) {
    this.storage.syncHistory(botId);
    const run = this.store.data.runs.find((run) => run.id === runId),
      request = [...this.store.data.messages]
        .reverse()
        .find(
          (message) =>
            message.runId === runId &&
            (message.role === 'user' || (run?.peerOrigin?.kind === 'peer_task' && message.taskSource)),
        );
    if (request?.reaction || routingOnlyRun(this.store, runId) || request?.scheduled) {
      this.learning.schedule();
      return;
    }
    const route = request ? memoryRoute(this.store, request) : undefined;
    if (route && !route.targetBotIds.includes(botId)) {
      this.learning.schedule();
      return;
    }
    if (run?.status === 'completed' && request && messages && shouldReview(request.content, run.toolCalls)) {
      const candidates = this.store.data.messages
        .filter(
          (message) =>
            message.botId === botId &&
            (message.role === 'user' || message.role === 'tool') &&
            (!run.peerOrigin ||
              (message.runId === runId &&
                message.role === 'tool' &&
                message.status === 'done' &&
                message.tool !== 'memory')),
        )
        .slice(-32);
      if (request.role === 'user' && !candidates.some((message) => message.id === request.id))
        candidates.unshift(request);
      if (!candidates.length) {
        this.learning.schedule();
        return;
      }
      const payload: ReviewPayload = {
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        sourceRefs: candidates.map((message) => message.id),
        revision: this.storage.revision(botId),
        model: this.store.modelFor(botId).model,
      };
      // Whether this run is worth a skill review is decided when its conversation is read.
      this.learning.enqueue(botId, runId, payload, 'held');
    } else this.learning.schedule();
  }
  /**
   * The memory a run starts with besides the frozen core: corrections made since and what relates to the request.
   * Any failure here costs the run nothing but this extra context.
   */
  async turnMemory(
    botId: string,
    runId: string,
    stateKey: string,
    where: WhereInput,
    query: string,
  ): Promise<{ text: string; recalled: MemoryRef[] }> {
    const nothing = { text: '', recalled: [] };
    try {
      const conversation = conversationKey({ botId, ...where });
      if (this.memory.mode(botId, conversation) === 'off' || !query.trim()) return nothing;
      const context = this.memory.contextFor(botId, where),
        previous = [...this.store.data.messages]
          .reverse()
          .find(
            (message) =>
              message.botId === botId &&
              message.sessionId === where.sessionId &&
              message.role === 'user' &&
              message.runId !== runId &&
              !message.reaction,
          ),
        semantic = await this.vectors?.similar(query, visibleScopes(context).scopes, ['item', 'episode']);
      return this.memory.turnMemory(stateKey, context, {
        query,
        ...(previous && !where.groupId ? { recent: previous.content.slice(0, 500), lastActiveAt: previous.time } : {}),
        conversation,
        ...(semantic ? { semantic } : {}),
        contextTokens: this.store.modelFor(botId).contextTokens,
      });
    } catch {
      return nothing;
    }
  }
  /**
   * history_search: facts and episodes first, then the conversation records they came from. Only what this
   * conversation may see; facts kept out of it stay out here too.
   */
  async deepSearch(
    botId: string,
    query: string,
    limit: number,
    here: string | null,
    where: WhereInput,
    options: { since?: string; until?: string; kinds?: string[]; includeToolOutput?: boolean } = {},
  ) {
    const context = this.memory.contextFor(botId, where),
      { scopes, privateOk } = visibleScopes(context),
      kinds = options.kinds?.length ? options.kinds : ['fact', 'episode', 'message'],
      wanted: Array<'item' | 'episode' | 'message'> = [
        ...(kinds.includes('fact') ? (['item'] as const) : []),
        ...(kinds.includes('episode') ? (['episode'] as const) : []),
        ...(kinds.includes('message') ? (['message'] as const) : []),
      ],
      semantic = await this.vectors?.similar(query, scopes, wanted, 800),
      items = this.storage.items,
      scored = new Map<string, number>(),
      inRange = (time: string) =>
        (!options.since || time >= options.since) && (!options.until || time <= options.until);
    items
      .searchIndex(
        queryTokens(query),
        scopes,
        wanted.filter((kind): kind is 'item' | 'episode' => kind !== 'message'),
        40,
      )
      .forEach((hit, rank) => scored.set(hit.owner, 1 / (30 + rank)));
    [...(semantic || [])]
      .filter(([, value]) => value >= 0.45)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .forEach(([owner], rank) => scored.set(owner, (scored.get(owner) || 0) + 1 / (30 + rank)));
    const order = [...scored].sort((a, b) => b[1] - a[1]).map(([owner]) => owner),
      facts: unknown[] = [],
      episodes: unknown[] = [],
      extraMessages: string[] = [];
    for (const owner of order) {
      const item = items.get(owner);
      if (item) {
        if (
          !wanted.includes('item') ||
          (item.status !== 'active' && item.status !== 'archived') ||
          !scopes.includes(item.scope) ||
          (item.sensitivity === 'private' && !privateOk) ||
          !inRange(item.recordedAt) ||
          facts.length >= 6
        )
          continue;
        facts.push({
          kind: 'fact',
          id: '#' + shortId(item.id),
          text: item.text,
          recordedAt: item.recordedAt.slice(0, 10),
          origin: item.origin,
          ...(item.status === 'archived' ? { archived: true } : {}),
          ...(item.validUntil ? { validUntil: item.validUntil.slice(0, 10) } : {}),
          sources: item.sources.flatMap((source) => (source.messageId ? [source.messageId] : [])).slice(0, 3),
        });
        continue;
      }
      const episode = items.episode(owner);
      if (episode) {
        if (!wanted.includes('episode') || !inRange(episode.endedAt) || episodes.length >= 4) continue;
        episodes.push({
          kind: 'episode',
          title: episode.title,
          summary: episode.summary,
          time: episode.endedAt.slice(0, 16),
          outcome: episode.outcome,
          ...(episode.pending.length ? { pending: episode.pending } : {}),
          ...(episode.lastMessage ? { messageId: episode.lastMessage } : {}),
        });
      } else if (wanted.includes('message')) extraMessages.push(owner);
    }
    const messages: Array<Record<string, unknown>> = wanted.includes('message')
      ? this.storage.search(botId, query, limit, here, options)
      : [];
    const found = new Set(messages.map((message) => message.messageId));
    for (const id of extraMessages) {
      if (messages.length >= limit) break;
      if (found.has(id)) continue;
      try {
        const [row] = this.storage.readHistory(botId, id, 0, 0);
        if (row?.time && !inRange(row.time)) continue;
        if (row) messages.push({ ...row, excerpt: row.content, content: undefined });
      } catch {
        /* A record that is gone drops out of the results. */
      }
    }
    return [...facts, ...episodes, ...messages];
  }
  saveSkill(botId: string, runId: string, name: string, description: string, body: string, sourceRefs?: string[]) {
    knowledgeTextSafe(body, this.secrets());
    const refs =
      sourceRefs?.map((id) => {
        const message = this.storage.sourceMessage(botId, id);
        if (!message) throw new Error('技能来源不存在或无权访问');
        return message.id;
      }) ||
      this.store.data.messages
        .filter(
          (message) =>
            message.botId === botId &&
            ((message.runId === runId && message.role === 'user') ||
              (message.role === 'tool' && message.status === 'done')),
        )
        .slice(-5)
        .map((message) => message.id);
    const existing = this.skills.list(botId).find((skill) => skill.botId === botId && skill.name === name),
      before = existing ? this.skills.read(botId, existing.id).body : undefined;
    const result = this.skills.save(botId, name, description, body, {
      origin: 'foreground',
      sourceRunId: runId,
      sourceRefs: refs,
    });
    if (!result.unchanged) {
      this.storage.audit(botId, runId, 'skill', existing ? 'replace' : 'create', before, body, refs);
      this.storage.bump(botId);
    }
    return result;
  }
  view() {
    if (this.closing) return undefined;
    const learning = this.learning.status();
    return {
      learning: {
        ...learning,
        ...(this.worker.busy ? { working: true } : {}),
        queued: learning.queued + this.worker.queued,
      },
      bots: this.store.data.bots.map((bot) => {
        const events = this.storage.db
          .prepare(
            'SELECT kind,action,created_at FROM knowledge_events WHERE bot_id=? ORDER BY created_at DESC LIMIT 1',
          )
          .get(bot.id) as any;
        return {
          botId: bot.id,
          memoryRevision: this.storage.revision(bot.id),
          context: this.context.stats(bot.id),
          lastLearning: events ? { kind: events.kind, action: events.action, time: events.created_at } : undefined,
        };
      }),
    };
  }
  deleteBot(botId: string) {
    this.learning.preempt();
    this.worker.preempt();
    this.storage.clearBot(botId);
  }
  async close() {
    this.closing = true;
    await Promise.all([this.learning.close(), this.worker.close()]);
    this.storage.close();
  }
}
