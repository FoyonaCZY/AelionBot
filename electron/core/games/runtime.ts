import type { ResponseMetrics, GameModelConfig } from '../../../shared/types/game-types';
import { settleLimited } from './request-pool';
import { gameSkills } from './skills';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  GameCreate,
  GameAction,
  GameView,
  GameRequest,
  GamePlayer,
  GameTrace,
} from '../../../shared/types/game-types';
import { acceptAction, createWerewolf, view, validateAction, log, type WerewolfState } from './werewolf';
import { gamePrompt, gameInstructions, GameModelError } from './model-player';
import { assignPersonas, personaPick, type PersonaSeed } from './persona-play';
import { AppError } from '../../../shared/errors';
export interface DecisionOptions {
  retryFeedback?: string;
  onResponse: (metrics: ResponseMetrics) => void;
  /** Exact provider request, without transport configuration or credentials. */
  onRequest?: (request: { input: string; instruction: string; config: GameModelConfig }) => void;
}
export type Decide = (
  player: GamePlayer,
  context: GameView,
  request: GameRequest,
  signal: AbortSignal,
  options?: DecisionOptions,
) => Promise<GameAction>;
/** Post-match effects cannot affect the result, but failures remain pending for retry. */
export interface GameHooks {
  /** At-least-once delivery of a saved finished match. Effects must be idempotent; throw to retry. */
  finished?: (s: WerewolfState) => void | Promise<void>;
  /** One best-effort diagnostic per failed attempt, including a failed completion receipt write. */
  settlementFailed?: (matchId: string, error: unknown) => void;
  /** Personality of member Bots for a new match (§9.2), keyed by botId; seats without one keep the MBTI preset. */
  personas?: (bots: { botId: string; mbti?: string }[], members: string[]) => Record<string, PersonaSeed>;
}
export class GameRuntime {
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private states = new Map<string, WerewolfState>();
  private jobs = new Map<string, AbortController>();
  private settling = new Set<string>();
  private settlementRetryAt = new Map<string, number>();
  constructor(
    private dir: string,
    private decide: Decide,
    private check: (players: GamePlayer[]) => void = () => {},
    private timing = { aiTimeoutMs: 180000 },
    private hooks: GameHooks = {},
  ) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'matches.json');
    if (existsSync(file)) {
      for (const s of JSON.parse(readFileSync(file, 'utf8')) as WerewolfState[]) {
        s.trace ||= [];
        s.revision ||= 0;
        if (s.status === 'paused' && s.error?.startsWith('AI 行动失败')) {
          const failure = [...s.trace].reverse().find((e) => e.type === 'model_failed');
          if (failure?.detail?.includes('HTTP ')) s.error = failure.detail + '；点击继续可重试，已完成的行动会保留。';
        }
        if (s.status === 'running') {
          this.freeze(s);
          s.status = 'paused';
          s.error = '服务已重启，点击继续恢复对局';
          log(s, '系统：服务重启，对局已暂停。');
          this.record(s, 'recovered');
          s.revision++;
        }
        for (const old of this.states.values())
          if (old.groupId === s.groupId && (!this.needsSettlement(old) || old.settlementComplete === undefined))
            this.states.delete(old.id);
        this.states.set(s.id, s);
      }
      // Old files promised only the latest match per group. Migrate that checkpoint,
      // while retaining explicitly pending effects from this version across later matches.
      for (const s of this.states.values())
        if (this.needsSettlement(s)) {
          if (s.settlementComplete === undefined) s.settlementLegacy = true;
          s.settlementComplete = false;
        }
      this.persist();
    }
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
    for (const s of this.states.values()) this.queueSettlement(s);
  }
  private needsSettlement(s: WerewolfState) {
    return !!this.hooks.finished && s.status === 'finished' && !s.settlementComplete;
  }
  private queueSettlement(s: WerewolfState) {
    if (
      this.closed ||
      !this.hooks.finished ||
      !this.needsSettlement(s) ||
      this.settling.has(s.id) ||
      (this.settlementRetryAt.get(s.id) || 0) > Date.now()
    )
      return;
    this.settling.add(s.id);
    queueMicrotask(() => void this.finishSettlement(s.id));
  }
  private async finishSettlement(id: string) {
    try {
      const s = this.states.get(id);
      if (this.closed || !s || !this.needsSettlement(s)) return;
      await this.hooks.finished!(structuredClone(s));
      // A closing runtime never acknowledges work that may still be shutting down in other services.
      if (this.closed) return;
      this.commit({ ...s, settlementComplete: true }, false);
      this.settlementRetryAt.delete(id);
    } catch (error) {
      // Keep the finished checkpoint and retry from the real timer or the next startup.
      this.settlementRetryAt.set(id, Date.now() + 30_000);
      try {
        this.hooks.settlementFailed?.(id, error);
      } catch {
        // A diagnostics failure must not strand the pending settlement.
      }
    } finally {
      this.settling.delete(id);
    }
  }
  private record(s: WerewolfState, type: GameTrace['type'], detail: Partial<GameTrace> = {}) {
    (s.trace ||= []).push({ seq: s.trace.length + 1, time: Date.now(), type, day: s.day, phase: s.phase, ...detail });
  }
  private annotate(id: string, type: GameTrace['type'], detail: Partial<GameTrace> = {}) {
    const current = this.states.get(id);
    // A stopped/finished archive is immutable, including late provider callbacks.
    if (this.closed || !current || current.status === 'finished') return;
    const s = structuredClone(current);
    this.record(s, type, detail);
    this.commit(s, false);
  }
  private freeze(s: WerewolfState) {
    for (const r of s.requests) {
      if (!s.seats.find((p) => p.id === r.seatId)?.human) {
        delete r.deadlineAt;
        delete r.remainingMs;
        continue;
      }
      r.remainingMs = Math.max(0, (r.deadlineAt || Date.now() + 30000) - Date.now());
      delete r.deadlineAt;
    }
  }
  private tick() {
    if (this.closed) return;
    for (const current of this.states.values()) {
      this.queueSettlement(current);
      if (current.status !== 'running') continue;
      const expired = current.requests.filter((r) => r.deadlineAt !== undefined && r.deadlineAt <= Date.now());
      if (!expired.length) continue;
      const s = structuredClone(current);
      const aiExpired = expired.filter((r) => !s.seats.find((p) => p.id === r.seatId)?.human);
      if (aiExpired.length) {
        for (const r of aiExpired)
          this.record(s, 'timeout', {
            requestId: r.id,
            seatId: r.seatId,
            kind: r.kind,
            detail: '模型响应超时，保留待办行动，未代替玩家选择',
          });
        this.freeze(s);
        s.status = 'paused';
        s.error = '模型响应超时，对局已暂停；点击继续重试未完成的行动，已完成的选择会保留。';
        this.record(s, 'failure_pause', { detail: s.error });
        log(s, '系统：模型响应超时，已暂停，未执行默认行动。');
        try {
          this.commit(s);
        } finally {
          this.jobs.get(s.id)?.abort();
        }
        continue;
      }
      for (const r of expired) {
        if (!s.requests.some((x) => x.id === r.id)) continue;
        this.record(s, 'timeout', { requestId: r.id, seatId: r.seatId, kind: r.kind });
        acceptAction(s, r.id, r.kind === 'speak' ? { text: '（发言超时）' } : {}, true);
      }
      try {
        this.commitTransition(current, s);
        this.jobs.get(s.id)?.abort();
        this.pump(s.id);
      } catch {
        this.jobs.get(s.id)?.abort();
        const frozen = structuredClone(current);
        this.freeze(frozen);
        frozen.status = 'paused';
        frozen.error = '保存失败，已停止推进';
        this.states.set(s.id, frozen);
      }
    }
  }
  private persist() {
    const file = join(this.dir, 'matches.json'),
      temp = file + '.tmp';
    writeFileSync(temp, JSON.stringify([...this.states.values()]), { mode: 0o600 });
    renameSync(temp, file);
  }
  private commit(s: WerewolfState, visible = true) {
    const previous = this.states.get(s.id);
    if (this.needsSettlement(s)) s.settlementComplete = false;
    for (const r of s.requests)
      if (!s.seats.find((p) => p.id === r.seatId)?.human && !previous?.requests.some((old) => old.id === r.id)) {
        delete r.deadlineAt;
        delete r.remainingMs;
      }
    s.revision = (previous?.revision || 0) + (visible ? 1 : 0);
    this.states.set(s.id, s);
    try {
      this.persist();
    } catch (e) {
      if (previous) this.states.set(s.id, previous);
      else this.states.delete(s.id);
      throw e;
    }
    this.queueSettlement(s);
  }
  private commitTransition(previous: WerewolfState, next: WerewolfState) {
    if (previous.phase !== next.phase || previous.day !== next.day || previous.status !== next.status)
      this.record(next, 'transition', {
        detail: `${previous.day}/${previous.phase}/${previous.status} → ${next.day}/${next.phase}/${next.status}`,
      });
    for (const r of next.requests)
      if (!previous.requests.some((old) => old.id === r.id))
        this.record(next, 'request_created', {
          requestId: r.id,
          seatId: r.seatId,
          kind: r.kind,
          detail: next.seats.find((p) => p.id === r.seatId)?.human
            ? `操作截止时间 ${r.deadlineAt}`
            : '等待模型响应；响应超时保留行动',
        });
    this.commit(next);
  }
  private state(id: string) {
    const s = this.states.get(id);
    if (!s) throw Error('对局不存在');
    return s;
  }
  private public(s: WerewolfState, omniscient = false) {
    return view(s, s.seats.find((p) => p.human)?.id, omniscient);
  }
  read(groupId: string, omniscient = false) {
    const s = [...this.states.values()].reverse().find((s) => s.groupId === groupId);
    return s ? this.public(s, omniscient) : null;
  }
  inspect(id: string) {
    const s = this.state(id);
    if (s.status !== 'finished' && s.seats.some((p) => p.human))
      throw new AppError('game.record_locked', '真人对局结束后才能查看完整运行记录');
    return structuredClone(s.trace || []);
  }
  create(input: GameCreate) {
    if (this.closed) throw Error('游戏服务已关闭');
    if (
      !input ||
      typeof input.groupId !== 'string' ||
      !input.groupId.trim() ||
      !Array.isArray(input.players) ||
      ![7, 12].includes(input.players.length)
    )
      throw Error('需要七位或十二位玩家');
    if (
      input.players.some(
        (p) =>
          !p ||
          typeof p.id !== 'string' ||
          !p.id ||
          typeof p.name !== 'string' ||
          !p.name.trim() ||
          p.name.length > 80 ||
          typeof p.human !== 'boolean',
      ) ||
      new Set(input.players.map((p) => p.id)).size !== input.players.length ||
      input.players.filter((p) => p.human).length > 1
    )
      throw Error('玩家信息无效或重复');
    if ([...this.states.values()].some((s) => s.groupId === input.groupId && s.status !== 'finished'))
      throw Error('请先结束当前对局');
    this.check(input.players);
    const s = createWerewolf(
      input.groupId,
      // Seat ids are random per match; the Bot a seat belongs to is kept as botId for post-match settlement.
      input.players.map(({ botId, ...p }) => ({ ...p, id: randomUUID(), ...(botId ? { botId } : {}) })),
      undefined,
      input.board,
    );
    s.personaPolicy = 'model_semantic_v1';
    try {
      const bots = s.seats.filter((p) => p.botId && !p.human);
      if (bots.length && this.hooks.personas) {
        const members = s.seats.map((p) => (p.human ? 'user' : p.botId)).filter((x): x is string => !!x);
        assignPersonas(
          s,
          this.hooks.personas(
            bots.map((p) => ({ botId: p.botId!, mbti: p.mbti })),
            members,
          ),
        );
      }
    } catch {
      // Without personas the match plays exactly as before.
      delete s.persona;
    }
    this.record(s, 'created', {
      detail: `规则 ${s.twelve ? s.twelve.board + '-sheriff-v1' : 'seven-player-v1'}；真人发言120秒、行动45秒；AI响应${this.timing.aiTimeoutMs / 1000}秒，超时暂停且保留行动`,
    });
    for (const [seatId, p] of Object.entries(s.persona || {}))
      if (p.plan)
        this.record(s, 'persona_plan', {
          seatId,
          detail: `${p.mbti}；本局打法「${p.plan.name}」（抽中概率 ${p.plan.prob.toFixed(2)}）`,
        });
    for (const r of s.requests) this.record(s, 'request_created', { requestId: r.id, seatId: r.seatId, kind: r.kind });
    // Keep pending effects even when the user starts the next match; only the latest match is visible.
    const replaced = [...this.states.values()].filter(
      (old) => old.groupId === input.groupId && !this.needsSettlement(old),
    );
    for (const old of replaced) this.states.delete(old.id);
    try {
      this.commit(s);
    } catch (e) {
      for (const old of replaced) this.states.set(old.id, old);
      throw e;
    }
    this.pump(s.id);
    return this.public(s);
  }
  act(id: string, requestId: string, action: GameAction) {
    this.tick();
    const s = this.state(id),
      human = s.seats.find((p) => p.human);
    if (!human) throw Error('旁观者不能行动');
    if (s.accepted.includes(requestId)) {
      const trace = (s.trace || []).find(
        (t) => t.type === 'action_accepted' && t.requestId === requestId && t.seatId === human.id,
      );
      if (trace) return this.public(s);
      throw Error('行动已超时或失效');
    }
    const request = s.requests.find((r) => r.id === requestId && r.seatId === human.id);
    if (!request) throw Error('不是你的行动，或请求已失效');
    const next = structuredClone(s);
    try {
      acceptAction(next, requestId, action);
    } catch (e) {
      this.annotate(id, 'action_rejected', { requestId, seatId: human.id, detail: (e as Error).message });
      throw e;
    }
    this.record(next, 'action_accepted', { requestId, seatId: human.id, kind: request.kind, action });
    this.commitTransition(s, next);
    this.pump(id);
    return this.public(next);
  }
  control(id: string, action: 'pause' | 'resume' | 'stop') {
    if (this.closed) throw Error('游戏服务已关闭');
    const s = structuredClone(this.state(id));
    if (s.status === 'finished') return this.public(s);
    if (action === 'resume') {
      if (s.status === 'running') return this.public(s);
      if (s.day > 20) throw Error('已达到运行上限，请结束本局');
      this.check(s.seats);
      s.status = 'running';
      for (const r of s.requests) {
        if (s.seats.find((p) => p.id === r.seatId)?.human) r.deadlineAt = Date.now() + (r.remainingMs ?? 30000);
        else delete r.deadlineAt;
        delete r.remainingMs;
      }
      delete s.error;
      log(s, '你继续了对局。');
    } else if (action === 'pause') {
      if (s.status === 'paused') return this.public(s);
      this.freeze(s);
      s.status = 'paused';
      log(s, '你暂停了对局。');
    } else if (action === 'stop') {
      // Close outstanding calls before publishing the finished checkpoint. Waiting for
      // an AbortSignal rejection would allow two exports of the same match to differ.
      const trace = [...(s.trace || [])];
      for (const started of trace.filter((e) => e.type === 'model_started')) {
        const ended = trace.some(
          (e) =>
            e.seq > started.seq &&
            e.requestId === started.requestId &&
            ['model_started', 'model_returned', 'model_failed', 'model_cancelled'].includes(e.type),
        );
        if (!ended)
          this.record(s, 'model_cancelled', {
            requestId: started.requestId,
            seatId: started.seatId,
            kind: started.kind,
            attempt: started.attempt,
            elapsedMs: Math.max(0, Date.now() - started.time),
            detail: '用户结束对局，请求取消',
          });
      }
      s.status = 'finished';
      s.phase = 'finished';
      s.requests = [];
      s.error = undefined;
      log(s, '你结束了对局，本局不计胜负。');
    } else throw Error('无效操作');
    this.record(s, action);
    this.commit(s);
    this.jobs.get(id)?.abort();
    if (action === 'resume') this.pump(id);
    return this.public(s);
  }
  private pump(id: string) {
    if (this.closed || this.jobs.has(id)) return;
    const saved = this.state(id);
    if (saved.status !== 'running') return;
    if (saved.personaPolicy !== 'model_semantic_v1') {
      const s = structuredClone(saved);
      s.personaPolicy = 'model_semantic_v1';
      this.commit(s, false);
    }
    const controller = new AbortController();
    this.jobs.set(id, controller);
    void this.run(id, controller.signal)
      .catch(() => {
        if (this.closed || controller.signal.aborted) return;
        const s = structuredClone(this.state(id));
        if (!this.closed && !controller.signal.aborted && s.status === 'running') {
          this.freeze(s);
          s.status = 'paused';
          this.record(s, 'failure_pause');
          log(s, '系统：AI 请求失败，对局已暂停。');
          const failure = [...(s.trace || [])].reverse().find((e) => e.type === 'model_failed');
          s.error = (failure?.detail || 'AI 请求或行动校验失败') + '；对局已暂停，点击继续可重试，已完成的行动会保留。';
          try {
            this.commit(s);
          } catch {
            s.error = '保存失败，请检查磁盘后重新打开应用。';
            this.states.set(id, s);
          }
        }
      })
      .finally(() => {
        if (this.jobs.get(id) === controller) this.jobs.delete(id);
        const s = this.states.get(id);
        if (
          !this.closed &&
          s?.status === 'running' &&
          s.requests.some((r) => !s.seats.find((p) => p.id === r.seatId)?.human)
        )
          this.pump(id);
      });
  }
  private async run(id: string, signal: AbortSignal) {
    while (!signal.aborted && !this.closed) {
      const snapshot = this.state(id);
      if (snapshot.status !== 'running') return;
      const requests = snapshot.requests.filter((r) => !snapshot.seats.find((p) => p.id === r.seatId)?.human);
      if (!requests.length) return;
      // Snapshot remains fixed for simultaneous decisions; each successful result commits immediately.
      const queuedAt = Date.now();
      for (const r of requests)
        this.annotate(id, 'model_queued', {
          requestId: r.id,
          seatId: r.seatId,
          kind: r.kind,
          detail: '进入请求队列，排队不占模型响应预算',
        });
      const results = await settleLimited(requests, 3, signal, async (r) => {
        const seat = snapshot.seats.find((p) => p.id === r.seatId)!,
          context = view(snapshot, seat.id);
        const dispatched = structuredClone(this.state(id)),
          pending = dispatched.requests.find((p) => p.id === r.id);
        if (!pending) return;
        pending.deadlineAt = Date.now() + this.timing.aiTimeoutMs;
        this.commit(dispatched, false);
        let retryFeedback: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          signal.throwIfAborted();
          const started = Date.now();
          this.annotate(id, 'model_started', {
            requestId: r.id,
            seatId: r.seatId,
            kind: r.kind,
            attempt,
            detail: attempt === 1 ? `排队 ${Date.now() - queuedAt} 毫秒后发出请求` : '重新请求',
            model: seat.model?.model,
            input: gamePrompt(context, r),
            instruction:
              gameInstructions(context, r) +
              (retryFeedback ? '\n上次校验失败：' + retryFeedback + '。请纠正本次 JSON 字段。' : ''),
            skills: gameSkills(context, r).map(({ id, title, version }) => ({ id, title, version })),
          });
          let result: GameAction;
          let capturedInput: string | undefined;
          let validating = false;
          try {
            result = await this.decide(seat, context, r, signal, {
              retryFeedback,
              onRequest: ({ input, instruction, config }) => {
                if (this.closed || signal.aborted) return;
                capturedInput = input;
                const captured = structuredClone(this.state(id));
                const event = [...(captured.trace || [])]
                  .reverse()
                  .find((e) => e.type === 'model_started' && e.requestId === r.id && e.attempt === attempt);
                if (!event) return;
                event.input = input;
                event.instruction = instruction;
                event.model = config.model;
                event.modelConfig = config;
                event.requestCaptured = true;
                this.commit(captured, false);
              },
              onResponse: (metrics) => {
                if (!this.closed && !signal.aborted)
                  this.annotate(id, 'model_response', {
                    requestId: r.id,
                    seatId: r.seatId,
                    kind: r.kind,
                    attempt,
                    metrics,
                  });
              },
            });
            if (this.closed) return;
            if (signal.aborted) {
              this.annotate(id, 'reply_discarded', {
                requestId: r.id,
                seatId: r.seatId,
                elapsedMs: Date.now() - started,
                detail: '请求已取消',
              });
              return;
            }
            this.annotate(id, 'model_returned', {
              requestId: r.id,
              seatId: r.seatId,
              kind: r.kind,
              attempt,
              elapsedMs: Date.now() - started,
              action: result,
            });
            validating = true;
            validateAction(snapshot, r, result);
          } catch (e) {
            if (this.closed) return;
            this.annotate(id, signal.aborted ? 'model_cancelled' : 'model_failed', {
              requestId: r.id,
              seatId: r.seatId,
              kind: r.kind,
              attempt,
              elapsedMs: Date.now() - started,
              detail: signal.aborted
                ? '请求取消'
                : validating
                  ? '非法行动：' + (e as Error).message
                  : e instanceof GameModelError
                    ? e.message
                    : e instanceof SyntaxError
                      ? '模型输出不是有效 JSON'
                      : (e as Error).name === 'TimeoutError'
                        ? '模型请求超时'
                        : '模型请求或行动校验失败',
              ...(e instanceof GameModelError && e.output !== undefined ? { output: e.output } : {}),
            });
            if (validating && !signal.aborted)
              this.annotate(id, 'action_rejected', {
                requestId: r.id,
                seatId: r.seatId,
                kind: r.kind,
                attempt,
                detail: '模型行动未通过规则校验',
              });
            if (validating || (e instanceof GameModelError && e.code === 'format'))
              retryFeedback = (e as Error).message;
            if (signal.aborted || attempt === 2) throw e;
            const left = (this.state(id).requests.find((p) => p.id === r.id)?.deadlineAt || 0) - Date.now();
            if (left < 15000) throw e;
            if (e instanceof GameModelError && /HTTP (429|5\d\d)/.test(e.message))
              await new Promise<void>((resolve, reject) => {
                const abort = () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                };
                const timer = setTimeout(() => {
                  signal.removeEventListener('abort', abort);
                  resolve();
                }, 1500);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) {
                  signal.removeEventListener('abort', abort);
                  abort();
                }
              });
            continue;
          }
          this.tick();
          const current = this.state(id);
          if (signal.aborted || current.status !== 'running' || !current.requests.some((p) => p.id === r.id)) {
            this.annotate(id, 'reply_discarded', { requestId: r.id, seatId: r.seatId, detail: '阶段或请求已失效' });
            return;
          }
          const next = structuredClone(current);
          const open = next.requests.find((p) => p.id === r.id)!;
          // Personality may swap the model's pick for another reasonable candidate in a weak situation (§8.3).
          const picked = personaPick(
            next,
            open,
            result,
            (a) => {
              try {
                validateAction(next, open, a);
                return true;
              } catch {
                return false;
              }
            },
            capturedInput,
          );
          if (picked.decision) (next.decisions ||= []).push(picked.decision);
          if (picked.decision?.overridden)
            this.record(next, 'persona_override', {
              requestId: r.id,
              seatId: r.seatId,
              kind: r.kind,
              action: picked.action,
              detail: `模型首选 ${JSON.stringify({ target: result.target, potion: result.potion, choice: result.choice, skip: result.skip })}，人格在 ${picked.decision.options} 个合理候选中选择了另一个（概率 ${picked.decision.prob.toFixed(2)}）`,
            });
          acceptAction(next, r.id, picked.action);
          this.record(next, 'action_accepted', {
            requestId: r.id,
            seatId: r.seatId,
            kind: r.kind,
            action: picked.action,
          });
          this.commitTransition(current, next);
          return;
        }
      });
      signal.throwIfAborted();
      if (results.some((r) => r.status === 'rejected')) throw Error('AI decision failed');
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
    }
  }
  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    for (const c of this.jobs.values()) c.abort();
  }
}
