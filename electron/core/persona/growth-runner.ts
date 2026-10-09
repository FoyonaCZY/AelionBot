import { createHash, randomUUID } from 'node:crypto';
import type {
  GrowthModelInfo,
  GrowthObservation,
  GrowthReviewRecord,
  GrowthReviewState,
} from '../../../shared/types/persona-growth-types';
import { TRAITS, roundTraits, type Traits } from '../../../shared/persona/persona-model';
import {
  GROWTH_POLICY_VERSION,
  GROWTH_MIN_MATCHES,
  GROWTH_MIN_OBSERVATIONS,
  GROWTH_REVIEW_INTERVAL_MS,
  GROWTH_FAILURE_RETRY_MS,
  buildGrowthPrompt,
  parseGrowthAssessment,
  growthReviewDelta,
} from '../../../shared/persona/growth-review';
import { PersonaStore } from './persona-store';
import { estimateRequest } from '../context/context-budget';
import type { PersonaProfile } from '../../../shared/types/persona-types';

export interface GrowthReviewerHooks {
  ask(
    botId: string,
    system: string,
    user: string,
    signal: AbortSignal,
  ): Promise<{ text: string; model?: GrowthModelInfo }>;
  available(botId: string): boolean;
  /** Input allowance after reserving output and provider-specific safety margin. */
  inputTokenBudget?(botId: string): number;
}
const zero = (): Traits => ({ E: 0, A: 0, C: 0, N: 0, O: 0 });
const same = (a: Traits, b: Traits) => TRAITS.every((trait) => a[trait] === b[trait]);
const dayStart = (at: number) => at - (at % 86_400_000);

/** One bounded background call at a time. The SQLite audit and profile mutation always commit together. */
export class GrowthRunner {
  private hooks?: GrowthReviewerHooks;
  private queue = new Set<string>();
  private draining = false;
  private closed = false;
  private wake?: ReturnType<typeof setTimeout>;
  private active?: { record: GrowthReviewRecord; controller: AbortController; finished: boolean };
  /** A write failure must remain visible even while SQLite cannot save its failure audit. */
  private failedWrites = new Map<string, GrowthReviewRecord>();

  constructor(
    private store: PersonaStore,
    private now: () => number,
  ) {
    for (const record of store.interruptedGrowthReviews()) {
      store.saveGrowthReview({
        ...record,
        status: 'failed',
        completedAt: now(),
        summary: '上次评估被应用退出中断，未修改人格。',
      });
    }
  }

  configure(hooks: GrowthReviewerHooks) {
    this.hooks = hooks;
    for (const botId of this.store.pendingGrowthBots()) this.queue.add(botId);
    this.start();
  }
  consider(botId: string) {
    if (this.closed) return;
    this.queue.add(botId);
    this.start();
  }

  record(observations: GrowthObservation[]) {
    if (this.closed) return;
    this.store.transaction(() => {
      for (const observation of observations) {
        // Temporary seats and deleted Bots must never gain persistent profiles through the reviewer.
        if (!this.store.profile(observation.botId)) continue;
        this.store.addGrowthObservation(observation);
        this.queue.add(observation.botId);
      }
    });
    this.start();
  }

  request(botId: string) {
    if (this.closed) throw Error('人格服务已关闭');
    const state = this.state(botId);
    if (state.running) return;
    if (state.reason) throw Error(state.reason);
    this.queue.add(botId);
    this.start();
  }

  state(botId: string): GrowthReviewState {
    const observations = this.store.pendingGrowthObservations(botId);
    const failedWrite = this.failedWrites.get(botId);
    const stored = this.store.growthReviews(botId);
    const recent = failedWrite ? [failedWrite, ...stored.filter((r) => r.id !== failedWrite.id)].slice(0, 20) : stored;
    const profile = this.store.profile(botId);
    const matches = new Set(observations.map((o) => o.matchId)).size;
    const running = this.active?.record.botId === botId && !this.active.finished;
    const last = failedWrite || this.store.latestThrottledGrowthReview(botId);
    const nextEligibleAt = last
      ? (last.completedAt ?? last.createdAt) +
        (last.status === 'applied' || last.status === 'unchanged' ? GROWTH_REVIEW_INTERVAL_MS : GROWTH_FAILURE_RETRY_MS)
      : undefined;
    let reason: string | undefined;
    if (!profile) reason = '首次入座或确认人格后开始积累行为记录。';
    else if (profile.locked) reason = '已锁定成长，行为记录会保留。';
    else if (!this.hooks || !this.available(botId)) reason = '当前 Bot 的模型配置不可用。';
    else if (running) reason = '正在比较多局行为，完成后更新。';
    else if (matches < GROWTH_MIN_MATCHES || observations.length < GROWTH_MIN_OBSERVATIONS)
      reason = `至少需要 ${GROWTH_MIN_MATCHES} 局、${GROWTH_MIN_OBSERVATIONS} 条尚未评估的行为记录。`;
    else if (nextEligibleAt && nextEligibleAt > this.now()) reason = '评估冷却中，稍后可重试。';
    const applied = this.store.latestAppliedGrowthReview(botId);
    const canUndo =
      applied &&
      profile &&
      !this.store.hasGrowthReversal(applied.id) &&
      this.store.growthEpoch(botId) === applied.profileEpoch &&
      profile.n === applied.nBefore + 1 &&
      same(profile.traits, applied.after) &&
      same(profile.anchor, applied.anchor);
    return {
      running: !!running,
      eligibleObservations: observations.length,
      eligibleMatches: matches,
      minObservations: GROWTH_MIN_OBSERVATIONS,
      minMatches: GROWTH_MIN_MATCHES,
      nextEligibleAt: nextEligibleAt && nextEligibleAt > this.now() ? nextEligibleAt : undefined,
      reason,
      latest: recent[0],
      recent,
      canUndoReviewId: canUndo ? applied.id : undefined,
    };
  }

  cancel(botId: string) {
    this.queue.delete(botId);
    const active = this.active;
    if (active?.record.botId !== botId || active.finished) return;
    this.finish(active, {
      ...active.record,
      status: 'stale',
      completedAt: this.now(),
      summary: '人格或模型设置已改变，本次评估作废。',
    });
    active.controller.abort();
  }

  /** Called only after durable member deletion; no audit may be written for this work again. */
  forget(botId: string) {
    this.queue.delete(botId);
    this.failedWrites.delete(botId);
    const active = this.active;
    if (active?.record.botId === botId) {
      active.finished = true;
      active.controller.abort();
    }
  }

  undo(botId: string, reviewId: string) {
    if (this.state(botId).canUndoReviewId !== reviewId) throw Error('只能撤回当前人格对应的最近一次成长评估。');
    const original = this.store.latestAppliedGrowthReview(botId)!;
    this.cancel(botId);
    const p = this.store.profile(botId)!;
    const at = this.now();
    const record: GrowthReviewRecord = {
      ...original,
      id: randomUUID(),
      status: 'reverted',
      createdAt: at,
      completedAt: at,
      before: { ...p.traits },
      after: { ...original.before },
      delta: Object.fromEntries(TRAITS.map((k) => [k, -original.delta[k]])) as Traits,
      nBefore: p.n,
      summary: '用户撤回了最近一次跨经历成长，人格恢复到评估前。',
      reverts: original.id,
    };
    this.store.transaction(() => {
      record.profileEpoch = this.store.advanceGrowthEpoch(botId);
      p.traits = { ...original.before };
      p.n = original.nBefore;
      p.updatedAt = at;
      this.store.saveProfile(p);
      this.addChange(record, '撤回跨经历成长');
      this.store.saveGrowthReview(record);
    });
  }

  close() {
    if (this.closed) return;
    if (this.active) this.cancel(this.active.record.botId);
    this.closed = true;
    this.queue.clear();
    if (this.wake) clearTimeout(this.wake);
    // Storage may have recovered since the failed write. Flush audits without restarting model work.
    for (const [botId, record] of this.failedWrites) {
      try {
        this.store.saveGrowthReview(record);
        this.failedWrites.delete(botId);
      } catch {
        // A still-unwritable store cannot persist this fallback; keep shutdown and cancellation safe.
      }
    }
  }

  private available(botId: string) {
    try {
      return !!this.hooks?.available(botId);
    } catch {
      return false;
    }
  }
  private start() {
    if (this.closed || !this.hooks || this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }
  private async drain() {
    try {
      while (!this.closed && this.queue.size) {
        const botId = this.queue.values().next().value!;
        this.queue.delete(botId);
        const state = this.state(botId);
        if (state.reason) {
          // Successful reviews may leave another complete batch waiting for the daily interval.
          // Failed calls only retry on a new match, explicit retry, or restart; never a recurring failure loop.
          if (
            state.nextEligibleAt &&
            state.eligibleMatches >= GROWTH_MIN_MATCHES &&
            state.eligibleObservations >= GROWTH_MIN_OBSERVATIONS &&
            !this.store.profile(botId)?.locked &&
            (state.latest?.status === 'applied' || state.latest?.status === 'unchanged')
          )
            this.schedule(state.nextEligibleAt);
          continue;
        }
        await this.run(botId);
      }
    } finally {
      this.draining = false;
    }
  }
  private wakeAt?: number;
  private schedule(at: number) {
    if (this.wake && this.wakeAt !== undefined && this.wakeAt <= at) return;
    if (this.wake) clearTimeout(this.wake);
    this.wakeAt = at;
    this.wake = setTimeout(
      () => {
        this.wake = undefined;
        this.wakeAt = undefined;
        if (this.closed) return;
        for (const botId of this.store.pendingGrowthBots()) this.queue.add(botId);
        this.start();
      },
      Math.min(2_147_483_647, Math.max(1, at - this.now())),
    );
    this.wake.unref?.();
  }
  private async run(botId: string) {
    const profile = this.store.profile(botId)!;
    const { observations, prompt, fits } = this.fitBatch(profile, this.store.pendingGrowthObservations(botId));
    const record: GrowthReviewRecord = {
      id: randomUUID(),
      botId,
      policyVersion: GROWTH_POLICY_VERSION,
      triggerMatchId: observations.at(-1)!.matchId,
      batchId: createHash('sha256')
        .update(observations.map((o) => o.id).join('\n'))
        .digest('hex'),
      createdAt: this.now(),
      status: 'running',
      summary: '正在比较较早与较新的实际行为。',
      observations,
      before: { ...profile.traits },
      after: { ...profile.traits },
      delta: zero(),
      anchor: { ...profile.anchor },
      nBefore: profile.n,
      profileEpoch: this.store.growthEpoch(botId),
      prompt,
    };
    const active = { record, controller: new AbortController(), finished: false };
    this.active = active;
    const timeout = setTimeout(() => active.controller.abort(), 45_000);
    timeout.unref?.();
    let abortListener: (() => void) | undefined;
    try {
      const failedWrite = this.failedWrites.get(botId);
      if (failedWrite) {
        this.store.saveGrowthReview(failedWrite);
        this.failedWrites.delete(botId);
      }
      this.store.saveGrowthReview(record);
      if (!fits) {
        this.finish(active, {
          ...record,
          status: 'failed',
          completedAt: this.now(),
          summary: '最小跨局证据仍超出当前模型的上下文额度，未调用模型；请提高模型上下文配置后重试。',
        });
        return;
      }
      const response = await Promise.race([
        this.hooks!.ask(botId, prompt.system, prompt.user, active.controller.signal),
        new Promise<never>((_, reject) => {
          abortListener = () => reject(Error('成长评估已中断'));
          active.controller.signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
      if (this.closed || active.finished) return;
      const current = this.store.profile(botId);
      if (
        !current ||
        current.locked ||
        !this.available(botId) ||
        this.store.growthEpoch(botId) !== record.profileEpoch ||
        current.n !== profile.n ||
        !same(current.traits, profile.traits) ||
        !same(current.anchor, profile.anchor)
      ) {
        this.finish(active, {
          ...record,
          status: 'stale',
          completedAt: this.now(),
          summary: '人格或模型设置已改变，本次评估作废。',
        });
        return;
      }
      record.output = response.text.slice(0, 64_000);
      record.model = response.model;
      try {
        if (response.text.length > 64_000) throw Error('评估回复过长');
        record.assessment = parseGrowthAssessment(response.text, observations);
      } catch {
        this.finish(active, {
          ...record,
          status: 'rejected',
          completedAt: this.now(),
          summary: '模型评估格式或证据引用未通过核验，人格保持不变。',
        });
        return;
      }
      record.delta = growthReviewDelta(
        current,
        record.assessment,
        this.store.growthMovedSince(botId, dayStart(this.now())),
      );
      record.after = roundTraits(
        Object.fromEntries(TRAITS.map((k) => [k, current.traits[k] + record.delta[k]])) as Traits,
      );
      record.delta = Object.fromEntries(
        TRAITS.map((k) => [k, Number((record.after[k] - record.before[k]).toFixed(6))]),
      ) as Traits;
      const changed = TRAITS.some((k) => record.delta[k] !== 0);
      record.status = changed ? 'applied' : 'unchanged';
      record.completedAt = this.now();
      record.summary = record.assessment.summary;
      this.store.transaction(() => {
        if (changed) {
          current.traits = { ...record.after };
          current.n++;
          current.updatedAt = record.completedAt!;
          this.store.saveProfile(current);
          this.addChange(record, '跨经历成长评估');
        }
        this.store.consumeGrowthObservations(observations.map((o) => o.id));
        this.store.saveGrowthReview(record);
      });
      active.finished = true;
      // A long backlog can contain further distinct matches; let the successful cooldown defer them.
      if (this.store.pendingGrowthObservations(botId).length >= GROWTH_MIN_OBSERVATIONS) this.queue.add(botId);
    } catch {
      if (!this.closed && !active.finished)
        this.finish(active, {
          ...record,
          after: { ...record.before },
          delta: zero(),
          status: 'failed',
          completedAt: this.now(),
          summary: '本次模型评估未完成，人格保持不变，可在冷却后重试。',
        });
    } finally {
      clearTimeout(timeout);
      if (abortListener) active.controller.signal.removeEventListener('abort', abortListener);
      if (this.active === active) this.active = undefined;
    }
  }
  /** Reduce whole observations evenly within each match; never truncate evidence or reinterpret its context. */
  private fitBatch(profile: PersonaProfile, pending: GrowthObservation[]) {
    let budget = 32_000;
    try {
      budget = this.hooks?.inputTokenBudget?.(profile.botId) ?? budget;
    } catch {
      budget = 0;
    }
    if (!Number.isFinite(budget) || budget < 0) budget = 0;
    const grouped = new Map<string, GrowthObservation[]>();
    for (const observation of pending) {
      const group = grouped.get(observation.matchId) || [];
      group.push(observation);
      grouped.set(observation.matchId, group);
    }
    const groups = [...grouped.values()];
    let observations = pending;
    let prompt = buildGrowthPrompt(profile, observations);
    const fits = () =>
      observations.length >= GROWTH_MIN_OBSERVATIONS &&
      new Set(observations.map((o) => o.matchId)).size >= GROWTH_MIN_MATCHES &&
      estimateRequest(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        [],
      ).tokens <= budget;
    if (fits()) return { observations, prompt, fits: true };
    const sample = (group: GrowthObservation[], count: number) =>
      group.length <= count
        ? group
        : Array.from({ length: count }, (_, i) => group[Math.round((i * (group.length - 1)) / (count - 1))]);
    let count = Math.max(...groups.map((g) => g.length));
    while (count > 2) {
      let nextCount = Math.max(2, Math.ceil(count / 2));
      let next = groups.flatMap((group) => sample(group, nextCount));
      while (next.length < GROWTH_MIN_OBSERVATIONS && nextCount < count) {
        nextCount++;
        next = groups.flatMap((group) => sample(group, nextCount));
      }
      if (nextCount === count) break;
      count = nextCount;
      observations = next;
      prompt = buildGrowthPrompt(profile, observations);
      if (fits()) return { observations, prompt, fits: true };
    }
    // Keep chronological coverage of the oldest complete batch; defer later matches rather than evaluate backward.
    while (groups.length > GROWTH_MIN_MATCHES) {
      const next = groups.slice(0, -1).flatMap((group) => sample(group, Math.max(2, count)));
      if (next.length < GROWTH_MIN_OBSERVATIONS) break;
      groups.pop();
      observations = next;
      prompt = buildGrowthPrompt(profile, observations);
      if (fits()) return { observations, prompt, fits: true };
    }
    return { observations, prompt, fits: false };
  }
  private addChange(record: GrowthReviewRecord, reason: string) {
    this.store.addEpisode({
      botId: record.botId,
      scope: 'game',
      sourceId: record.id,
      kind: record.status === 'reverted' ? 'growth_review_undo' : 'growth_review',
      summary: record.summary,
      s: {},
      o: 0,
      delta: record.delta,
      createdAt: record.completedAt!,
    });
    this.store.addHistory(record.botId, record.after, reason, record.completedAt!);
  }
  private finish(active: { finished: boolean }, record: GrowthReviewRecord) {
    try {
      this.store.saveGrowthReview(record);
    } catch {
      // Do not let a secondary audit error reject the unawaited background drain or strand the next Bot.
      // Keep the evidence unconsumed; a later explicit/new-match retry also persists this failed audit.
      this.failedWrites.set(record.botId, {
        ...record,
        status: 'failed',
        after: { ...record.before },
        delta: zero(),
        completedAt: this.now(),
        summary: '本次成长评估无法写入本地数据，人格保持不变；请检查存储空间，冷却后可重试。',
      });
    }
    active.finished = true;
  }
}
