import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaService } from '../electron/core/persona/persona-service';
import type { GrowthReviewerHooks } from '../electron/core/persona/growth-runner';
import type { GrowthAssessment, GrowthObservation } from '../shared/types/persona-growth-types';
import { TRAITS } from '../shared/persona/persona-model';
import { buildGrowthPrompt, GROWTH_FAILURE_RETRY_MS, GROWTH_REVIEW_INTERVAL_MS } from '../shared/persona/growth-review';
import { estimateRequest } from '../electron/core/context/context-budget';

const zero = { E: 0, A: 0, C: 0, N: 0, O: 0 };
function observations(botId = 'A', prefix = 'batch', at = Date.UTC(2026, 9, 6)): GrowthObservation[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `${prefix}-${i}`,
    botId,
    matchId: `${prefix}-match-${Math.floor(i / 2)}`,
    createdAt: at + i,
    role: i < 2 ? 'villager' : 'wolf',
    kind: 'speak',
    day: 1,
    behavior: JSON.stringify({ text: `行为证据${i}：我重新核对了大家提供的信息。` }),
    text: '仅实际可见的上下文，不能用作本人的行为证据。',
  }));
}
function output(input: GrowthObservation[], direction: -1 | 0 | 1 = 1): string {
  const assessment: GrowthAssessment = {
    version: 1,
    summary: direction ? '多局较新行为显示更持续的审慎核对倾向。' : '尚无持续变化证据，保持当前设置。',
    traits: Object.fromEntries(
      TRAITS.map((k) => [
        k,
        {
          attribution: k === 'C' && direction ? 'trait' : 'stable',
          direction: k === 'C' ? direction : 0,
          reason: '比較不同局、角色及较早与较新行为，排除单次结果。',
          evidence:
            k === 'C' && direction
              ? [input[0], input[2], input[4]].map((o) => ({ observationId: o.id, quote: o.behavior }))
              : [],
          counterEvidence: [],
        },
      ]),
    ) as unknown as GrowthAssessment['traits'],
  };
  return JSON.stringify(assessment);
}
const model = { model: 'fake-growth-reviewer', protocol: 'test' };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('background growth reviewer did not finish');
}
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-growth-review-'));
  let time = Date.UTC(2026, 9, 6, 12);
  let svc = new PersonaService(dir, () => time);
  let closed = false;
  t.after(() => {
    if (!closed) svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get svc() {
      return svc;
    },
    get time() {
      return time;
    },
    advance(ms: number) {
      time += ms;
    },
    reopen() {
      svc.close();
      svc = new PersonaService(dir, () => time);
    },
    close() {
      svc.close();
      closed = true;
    },
  };
}
function configure(svc: PersonaService, overrides: Partial<GrowthReviewerHooks> = {}) {
  svc.configureGrowthReviewer({
    available: () => true,
    ask: async (_bot, _system, user) => ({ text: output(JSON.parse(user).observations), model }),
    ...overrides,
  });
}

test('automatically assesses three completed matches, applies bounded change, consumes evidence only once', async (t) => {
  const f = fixture(t),
    svc = f.svc;
  const before = svc.ensureProfile('A');
  let calls = 0;
  configure(svc, {
    ask: async (_bot, _system, user) => {
      calls++;
      return { text: output(JSON.parse(user).observations), model };
    },
  });
  const obs = observations();
  svc.recordGrowthObservations(obs.slice(0, 4));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  svc.recordGrowthObservations(obs);
  await until(() => svc.view('A').growthReview?.latest?.status === 'applied');
  const after = svc.view('A');
  assert.equal(calls, 1);
  assert.equal(after.profile.traits.C, before.traits.C + 0.005);
  assert.equal(after.profile.n, 1);
  assert.deepEqual(after.profile.anchor, before.anchor);
  assert.equal(after.growthReview?.eligibleObservations, 0);
  assert.equal(after.episodes[0].kind, 'growth_review');
  const review = after.growthReview!.latest!;
  assert.ok(review.prompt && review.assessment && review.output);
  svc.recordGrowthObservations(obs);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, 'repeated settlement cannot reuse consumed evidence');
});

test('unchanged assessment consumes its batch without anchor drift, count increment or fabricated history', async (t) => {
  const { svc } = fixture(t);
  const p = svc.ensureProfile('A');
  p.traits.C = 0.733;
  p.n = 9;
  svc.store.saveProfile(p);
  const history = svc.view('A').history;
  configure(svc, { ask: async (_bot, _system, user) => ({ text: output(JSON.parse(user).observations, 0), model }) });
  svc.recordGrowthObservations(observations());
  await until(() => svc.view('A').growthReview?.latest?.status === 'unchanged');
  assert.deepEqual(svc.view('A').profile, p);
  assert.deepEqual(svc.view('A').history, history);
  assert.deepEqual(svc.view('A').growthReview?.latest?.delta, zero);
  assert.equal(svc.view('A').growthReview?.eligibleMatches, 0);
});

test('new evidence waits for the successful 24 hour interval and then can be assessed', async (t) => {
  const f = fixture(t),
    svc = f.svc;
  svc.ensureProfile('A');
  let calls = 0;
  configure(svc, {
    ask: async (_bot, _system, user) => {
      calls++;
      return { text: output(JSON.parse(user).observations), model };
    },
  });
  svc.recordGrowthObservations(observations());
  await until(() => svc.view('A').profile.n === 1);
  svc.recordGrowthObservations(observations('A', 'second', 200));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.throws(() => svc.requestGrowthReview('A'), /冷却/);
  f.advance(GROWTH_REVIEW_INTERVAL_MS);
  svc.requestGrowthReview('A');
  await until(() => svc.view('A').profile.n === 2);
  assert.equal(calls, 2);
});

test('invalid evidence rejects the batch, preserves it, and permits retry only after failure cooldown', async (t) => {
  const f = fixture(t),
    svc = f.svc;
  const before = svc.ensureProfile('A');
  let valid = false;
  configure(svc, {
    ask: async (_bot, _system, user) => ({
      text: valid ? output(JSON.parse(user).observations) : output(observations('A', 'invented')),
      model,
    }),
  });
  svc.recordGrowthObservations(observations());
  await until(() => svc.view('A').growthReview?.latest?.status === 'rejected');
  assert.deepEqual(svc.view('A').profile, before);
  assert.equal(svc.view('A').growthReview?.eligibleObservations, 6);
  assert.throws(() => svc.requestGrowthReview('A'), /冷却/);
  f.advance(GROWTH_FAILURE_RETRY_MS);
  valid = true;
  svc.requestGrowthReview('A');
  await until(() => svc.view('A').growthReview?.latest?.status === 'applied');
});

test('manual edit in the same millisecond invalidates an in-flight assessment', async (t) => {
  const { svc } = fixture(t);
  svc.ensureProfile('A');
  let resolve!: (result: { text: string; model: typeof model }) => void;
  let started = false;
  configure(svc, {
    ask: async () => {
      started = true;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  const obs = observations();
  svc.recordGrowthObservations(obs);
  await until(() => started);
  const manual = svc.setTraits('A', { E: 0.9, A: 0.2, C: 0.3, N: 0.4, O: 0.6 });
  resolve({ text: output(obs), model });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(svc.view('A').profile.traits, manual.profile.traits);
  assert.equal(svc.view('A').growthReview?.latest?.status, 'stale');
  assert.equal(svc.view('A').profile.n, 0);
});

test('locking stops an active call, unlocking evaluates retained observations afresh', async (t) => {
  const { svc } = fixture(t);
  svc.ensureProfile('A');
  let started = false;
  let aborted = false;
  let calls = 0;
  configure(svc, {
    ask: async (_bot, _system, user, signal) => {
      calls++;
      if (calls > 1) return { text: output(JSON.parse(user).observations), model };
      started = true;
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
  });
  svc.recordGrowthObservations(observations());
  await until(() => started);
  svc.setLocked('A', true);
  await until(() => aborted);
  assert.equal(svc.view('A').profile.n, 0);
  assert.equal(svc.view('A').growthReview?.latest?.status, 'stale');
  svc.setLocked('A', false);
  await until(() => svc.view('A').profile.n === 1);
  assert.equal(calls, 2);
});

test('undo is immutable, restores exact traits and count, and does not refund daily movement after reset', async (t) => {
  const f = fixture(t),
    svc = f.svc;
  const before = svc.ensureProfile('A');
  configure(svc);
  svc.recordGrowthObservations(observations());
  await until(() => svc.view('A').growthReview?.latest?.status === 'applied');
  const original = structuredClone(svc.view('A').growthReview!.latest!);
  assert.equal(svc.view('A').growthReview?.canUndoReviewId, original.id);
  const undone = svc.undoGrowthReview('A', original.id);
  assert.deepEqual(undone.profile.traits, before.traits);
  assert.equal(undone.profile.n, 0);
  assert.equal(undone.growthReview?.latest?.reverts, original.id);
  assert.deepEqual(
    svc.store.growthReviews('A').find((r) => r.id === original.id),
    original,
  );
  assert.throws(() => svc.undoGrowthReview('A', original.id));
  assert.equal(svc.store.growthMovedSince('A', f.time - 100).C, 0.01);
  svc.resetGrowth('A');
  assert.equal(
    svc.store.growthMovedSince('A', f.time - 100).C,
    0.01,
    'deleting visible episodes cannot refund the cap',
  );
});

test('daily absolute legacy movement also constrains a review and no-op does not consume a learning step', async (t) => {
  const f = fixture(t),
    svc = f.svc;
  const before = svc.ensureProfile('A');
  svc.store.addEpisode({
    botId: 'A',
    scope: 'game',
    sourceId: 'legacy',
    kind: 'vote',
    summary: '旧规则',
    s: {},
    o: 1,
    delta: { ...zero, C: -0.019 },
    createdAt: f.time,
  });
  configure(svc);
  svc.recordGrowthObservations(observations());
  await until(() => svc.view('A').growthReview?.latest?.status === 'applied');
  assert.equal(svc.view('A').profile.traits.C, before.traits.C + 0.001);
  assert.equal(svc.store.growthMovedSince('A', f.time).C, 0.02);
});

test('restart recovers interrupted audit and later retries durable observations', async (t) => {
  const f = fixture(t);
  f.svc.ensureProfile('A');
  let started = false;
  configure(f.svc, {
    ask: async () => {
      started = true;
      return new Promise(() => {});
    },
  });
  f.svc.recordGrowthObservations(observations());
  await until(() => started);
  const record = f.svc.view('A').growthReview!.latest!;
  // A running row is what an unclean process exit leaves behind. Reinsert after orderly close cancellation.
  f.reopen();
  f.svc.store.saveGrowthReview(record);
  f.reopen();
  assert.equal(f.svc.view('A').growthReview?.latest?.status, 'failed');
  configure(f.svc);
  assert.equal(f.svc.view('A').growthReview!.latest!.id, record.id);
  assert.equal(f.svc.view('A').profile.n, 0);
  f.advance(GROWTH_FAILURE_RETRY_MS);
  f.svc.requestGrowthReview('A');
  await until(() => f.svc.view('A').profile.n === 1);
});

test('forget and close cannot allow delayed results to resurrect or write a profile', async (t) => {
  const f = fixture(t),
    svc = f.svc;
  svc.ensureProfile('A');
  let resolve!: (result: { text: string; model: typeof model }) => void;
  let started = false;
  configure(svc, {
    ask: async () => {
      started = true;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  const obs = observations();
  svc.recordGrowthObservations(obs);
  await until(() => started);
  svc.forget('A');
  resolve({ text: output(obs), model });
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.store.profile('A'), undefined);
  assert.deepEqual(svc.store.growthReviews('A'), []);
  assert.deepEqual(svc.store.pendingGrowthObservations('A'), []);
  f.close();
  await new Promise((r) => setImmediate(r));
});

test('global runner serializes Bots and bounds each assessment to sixty observations', async (t) => {
  const { svc } = fixture(t);
  svc.ensureProfile('A');
  svc.ensureProfile('B');
  let active = 0,
    max = 0;
  const batchSizes: number[] = [];
  configure(svc, {
    ask: async (_bot, _system, user) => {
      active++;
      max = Math.max(max, active);
      const input = JSON.parse(user).observations as GrowthObservation[];
      batchSizes.push(input.length);
      await new Promise((r) => setImmediate(r));
      active--;
      return { text: output(input, 0), model };
    },
  });
  svc.recordGrowthObservations([
    ...Array.from({ length: 15 }, (_, i) => observations('A', `a${i}`, i * 100)).flat(),
    ...observations('B'),
  ]);
  await until(() => svc.view('B').growthReview?.latest?.status === 'unchanged');
  assert.equal(max, 1);
  assert.deepEqual(batchSizes, [60, 6]);
});

test('a failed atomic commit leaves traits, count and evidence untouched, with a zero-delta failure audit', async (t) => {
  const { svc } = fixture(t);
  const before = svc.ensureProfile('A');
  const history = svc.view('A').history;
  configure(svc);
  const original = svc.store.addHistory.bind(svc.store);
  svc.store.addHistory = () => {
    throw Error('simulated write failure');
  };
  svc.recordGrowthObservations(observations());
  await until(() => svc.view('A').growthReview?.latest?.status === 'failed');
  svc.store.addHistory = original;
  assert.deepEqual(svc.view('A').profile, before);
  assert.deepEqual(svc.view('A').history, history);
  assert.equal(svc.view('A').episodes.length, 0);
  assert.equal(svc.view('A').growthReview?.eligibleMatches, 3);
  assert.deepEqual(svc.view('A').growthReview?.latest?.delta, zero);
});

test('additional observations from an already consumed match never count as a new experience', async (t) => {
  const f = fixture(t),
    svc = f.svc;
  svc.ensureProfile('A');
  configure(svc);
  const obs = observations();
  svc.recordGrowthObservations(obs);
  await until(() => svc.view('A').profile.n === 1);
  f.advance(GROWTH_REVIEW_INTERVAL_MS);
  svc.recordGrowthObservations(obs.map((o) => ({ ...o, id: `${o.id}-late` })));
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.view('A').growthReview?.eligibleObservations, 0);
  assert.equal(svc.view('A').profile.n, 1);
});

test('large batches sample whole observations across matches to fit the configured input budget', async (t) => {
  const { svc } = fixture(t);
  svc.ensureProfile('A');
  const base = observations();
  const input = Array.from({ length: 60 }, (_, i) => ({
    ...base[Math.floor(i / 20) * 2],
    id: `long-${i}`,
    createdAt: base[0].createdAt + i,
    text: '这是实际可见的游戏上下文，不能截断其中的信息。'.repeat(20),
  }));
  let dispatched: GrowthObservation[] = [];
  configure(svc, {
    inputTokenBudget: () => 6000,
    ask: async (_bot, system, user) => {
      assert.ok(
        estimateRequest(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          [],
        ).tokens <= 6000,
      );
      dispatched = JSON.parse(user).observations;
      return { text: output(dispatched, 0), model };
    },
  });
  svc.recordGrowthObservations(input);
  await until(() => svc.view('A').growthReview?.latest?.status === 'unchanged');
  assert.ok(dispatched.length >= 6 && dispatched.length < 60);
  assert.equal(new Set(dispatched.map((o) => o.matchId)).size, 3);
  for (const observation of dispatched)
    assert.deepEqual(
      observation,
      input.find((o) => o.id === observation.id),
    );
  assert.deepEqual(svc.view('A').growthReview?.latest?.observations, dispatched);
});

test('an oversized minimum batch fails visibly before calling the model and retains its evidence', async (t) => {
  const { svc } = fixture(t);
  const before = svc.ensureProfile('A');
  let calls = 0;
  configure(svc, {
    inputTokenBudget: () => 4000,
    ask: async () => {
      calls++;
      throw Error('must not call');
    },
  });
  svc.recordGrowthObservations(
    observations().map((o) => ({ ...o, text: '每条行为对应完整的实际可见上下文。'.repeat(500) })),
  );
  await until(() => svc.view('A').growthReview?.latest?.status === 'failed');
  assert.equal(calls, 0);
  assert.match(svc.view('A').growthReview!.latest!.summary, /上下文额度/);
  assert.deepEqual(svc.view('A').profile, before);
  assert.equal(svc.view('A').growthReview?.eligibleObservations, 6);
  assert.deepEqual(svc.view('A').growthReview?.latest?.delta, zero);
});

test('uneven matches cannot shrink below six observations to satisfy the token allowance', async (t) => {
  const { svc } = fixture(t);
  const profile = svc.ensureProfile('A');
  const input = observations().map((o, i) => ({
    ...o,
    matchId: i < 4 ? 'large' : `small-${i}`,
    text: '不能为了通过上下文限制而降低证据条数门槛。'.repeat(30),
  }));
  const invalidPrompt = buildGrowthPrompt(profile, [input[0], input[3], input[4], input[5]]);
  const budget =
    estimateRequest(
      [
        { role: 'system', content: invalidPrompt.system },
        { role: 'user', content: invalidPrompt.user },
      ],
      [],
    ).tokens + 5;
  let calls = 0;
  configure(svc, {
    inputTokenBudget: () => budget,
    ask: async () => {
      calls++;
      throw Error('must not call below minimum');
    },
  });
  svc.recordGrowthObservations(input);
  await until(() => svc.view('A').growthReview?.latest?.status === 'failed');
  assert.equal(calls, 0);
  assert.equal(svc.view('A').growthReview?.latest?.observations.length, 6);
});

test('saving a new birth personality after real growth restarts its count and keeps relationships', async (t) => {
  const { svc, time } = fixture(t);
  svc.ensureProfile('A');
  configure(svc);
  svc.recordGrowthObservations(observations());
  await until(() => svc.view('A').growthReview?.latest?.status === 'applied');
  svc.store.addAffinity({ botId: 'A', targetId: 'B', value: 0.3, createdAt: time, durationDays: 30, source: 'shared' });
  const before = svc.affinity('A', 'B');
  assert.equal(svc.view('A').profile.n, 1);
  const next = svc.setTraits('A', { E: 0.2, A: 0.7, C: 0.6, N: 0.5, O: 0.8 });
  assert.equal(next.profile.n, 0);
  assert.deepEqual(next.profile.traits, next.profile.anchor);
  assert.equal(svc.affinity('A', 'B'), before);
  assert.equal(next.growthReview?.canUndoReviewId, undefined);
});
