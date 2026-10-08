import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaService, type PersonaMatch } from '../electron/core/persona/persona-service';
import { NEUTRAL } from '../shared/persona/persona-model';
import type { GrowthObservation } from '../shared/types/persona-growth-types';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-lifecycle-'));
  let svc = new PersonaService(dir, () => 1000);
  const db = new DatabaseSync(join(dir, 'persona.sqlite'));
  t.after(() => {
    svc.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get svc() {
      return svc;
    },
    db,
    reopen() {
      svc.close();
      svc = new PersonaService(dir, () => 1000);
      return svc;
    },
  };
}
function match(): PersonaMatch {
  return {
    id: 'finished-game',
    groupId: 'group',
    winner: 'village',
    seats: [
      { id: 'a', name: 'A', botId: 'A', human: false, role: 'villager' },
      { id: 'b', name: 'B', botId: 'B', human: false, role: 'wolf' },
      { id: 'c', name: 'C', botId: 'C', human: false, role: 'villager' },
    ],
    events: [],
    persona: { a: { botId: 'A', traits: { ...NEUTRAL }, mbti: 'ENFJ', affinity: {} } },
    decisions: [
      {
        requestId: 'vote',
        seatId: 'a',
        kind: 'vote',
        day: 1,
        strong: false,
        options: 2,
        chosen: { target: 'b' },
        subject: 'b',
        features: { assert: 1 },
        prob: 0.5,
        overridden: false,
      },
    ],
  };
}
function observations(): GrowthObservation[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `observation-${i}`,
    botId: 'A',
    matchId: `match-${Math.floor(i / 2)}`,
    createdAt: 1000 + i,
    role: i < 2 ? 'wolf' : 'villager',
    kind: 'speak',
    day: 1,
    behavior: JSON.stringify({ text: '我先复核一下大家的依据。' }),
    text: '已发送的上下文',
  }));
}

const flushGrowth = () => new Promise<void>((resolve) => setImmediate(resolve));
async function interruptedAudit(t: test.TestContext, phase: 'pending' | 'failed') {
  const f = fixture(t);
  f.svc.ensureProfile('A');
  let release!: () => void;
  f.svc.configureGrowthReviewer({
    available: () => true,
    ask: async (_bot, _system, user) => {
      const evidence: GrowthObservation[] = JSON.parse(user).observations;
      return new Promise((resolve) => {
        release = () =>
          resolve({
            text: JSON.stringify({
              version: 1,
              summary: '跨局行为表现出变化。',
              traits: Object.fromEntries(
                ['E', 'A', 'C', 'N', 'O'].map((k) => [
                  k,
                  {
                    attribution: k === 'C' ? 'trait' : 'stable',
                    direction: k === 'C' ? 1 : 0,
                    reason: '比较前后行为与角色限制。',
                    evidence:
                      k === 'C'
                        ? [0, 2, 4].map((i) => ({ observationId: evidence[i].id, quote: evidence[i].behavior }))
                        : [],
                    counterEvidence: [],
                  },
                ]),
              ),
            }),
          });
      });
    },
  });
  f.svc.recordGrowthObservations(observations());
  await flushGrowth();
  assert.equal(f.svc.view('A').growthReview?.latest?.status, 'running');
  f.db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON growth_review BEGIN SELECT RAISE(FAIL, 'audit write failure'); END",
  );
  if (phase === 'failed') {
    release();
    await flushGrowth();
    assert.equal(f.svc.view('A').growthReview?.latest?.status, 'failed');
  }
  return { f, release };
}

for (const phase of ['pending', 'failed'] as const) {
  for (const change of ['cancel', 'reset', 'set'] as const) {
    test(`${change} preserves the visible ${phase} audit write failure and close persists it without reactivating old work`, async (t) => {
      const { f, release } = await interruptedAudit(t, phase);
      if (change === 'cancel') f.svc.cancelGrowthReview('A');
      else if (change === 'reset') f.svc.resetGrowth('A');
      else f.svc.setTraits('A', { ...NEUTRAL, C: 0.8 });
      const after = f.svc.view('A');
      assert.equal(after.growthReview?.running, false);
      assert.equal(after.growthReview?.latest?.status, 'failed', 'a cancelled task must not appear as running');
      assert.match(after.growthReview!.latest!.summary, /写入/);
      f.db.exec('DROP TRIGGER fail_audit');
      release();
      await flushGrowth();
      assert.deepEqual(f.svc.view('A').profile, after.profile, 'late output has lost authority');
      const recovered = f.reopen().view('A');
      assert.deepEqual(
        recovered.growthReview?.latest,
        JSON.parse(JSON.stringify(after.growthReview?.latest)),
        'close flushes the exact failed audit after storage recovers',
      );
      assert.deepEqual(recovered.profile, after.profile);
      assert.equal(recovered.growthReview?.eligibleObservations, change === 'cancel' ? 6 : 0);
      let calls = 0;
      f.svc.configureGrowthReviewer({
        available: () => true,
        ask: async () => {
          calls++;
          throw Error('old work restarted');
        },
      });
      await flushGrowth();
      assert.equal(calls, 0, 'startup must respect discarded evidence and the persisted failure cooldown');
    });
  }

  test(`forget clears a ${phase} audit write failure and late output cannot recreate it after restart`, async (t) => {
    const { f, release } = await interruptedAudit(t, phase);
    f.svc.forget('A');
    f.db.exec('DROP TRIGGER fail_audit');
    release();
    await flushGrowth();
    assert.equal(f.svc.view('A').growthReview?.latest, undefined);
    assert.equal(f.svc.store.profile('A'), undefined);
    assert.deepEqual(f.svc.store.growthReviews('A'), []);
    const svc = f.reopen();
    svc.recordGrowthObservations(observations());
    assert.equal(svc.view('A').growthReview?.latest, undefined);
    assert.equal(svc.view('A').growthReview?.eligibleObservations, 0);
    assert.throws(() => svc.ensureProfile('A'), /已删除/);
  });
}

test('a reset interrupted by a SQLite write failure preserves growth and evidence after reopen', (t) => {
  const f = fixture(t);
  f.svc.ensureProfile('A');
  f.svc.settle(match());
  f.svc.recordGrowthObservations(observations());
  const before = f.svc.view('A');
  assert.ok(before.profile.n > 0);
  assert.ok(before.episodes.length > 0);
  f.db.exec(
    "CREATE TRIGGER fail_reset BEFORE INSERT ON profile WHEN json_extract(NEW.json, '$.n') = 0 BEGIN SELECT RAISE(FAIL, 'reset write failure'); END",
  );
  assert.throws(() => f.svc.resetGrowth('A'), /reset write failure/);
  f.db.exec('DROP TRIGGER fail_reset');
  const after = f.reopen().view('A');
  assert.deepEqual(after.profile, before.profile);
  assert.deepEqual(after.episodes, before.episodes, 'failed reset must not erase growth evidence');
  assert.deepEqual(after.history, before.history);
  assert.equal(after.growthReview?.eligibleObservations, 6);
  const reset = f.svc.resetGrowth('A');
  assert.equal(reset.profile.n, 0);
  assert.deepEqual(reset.profile.traits, reset.profile.anchor);
  assert.deepEqual(reset.episodes, []);
  assert.equal(reset.history.length, 1);
  assert.equal(reset.growthReview?.eligibleObservations, 0);
  assert.deepEqual(reset.relations, before.relations);
  assert.deepEqual(reset.highlights, before.highlights);
});

for (const action of ['reset', 'set'] as const) {
  test(`a ${action} excludes settled games whose first observation write failed, without excluding other Bots or new games`, (t) => {
    const f = fixture(t);
    f.svc.ensureProfile('A');
    f.svc.ensureProfile('B');
    const old = observations();
    for (const id of new Set(old.map((o) => o.matchId))) f.svc.settle({ ...match(), id });
    f.db.exec(
      "CREATE TRIGGER fail_observation BEFORE INSERT ON growth_observation BEGIN SELECT RAISE(FAIL, 'observation write failure'); END",
    );
    assert.throws(() => f.svc.recordGrowthObservations(old), /observation write failure/);
    f.db.exec('DROP TRIGGER fail_observation');
    assert.equal(f.svc.view('A').growthReview?.eligibleObservations, 0);
    if (action === 'reset') f.svc.resetGrowth('A');
    else f.svc.setTraits('A', { ...NEUTRAL, E: 0.8 });
    const svc = f.reopen();
    svc.recordGrowthObservations([...old, ...old.map((o) => ({ ...o, botId: 'B', id: `B-${o.id}` }))]);
    assert.equal(
      svc.view('A').growthReview?.eligibleObservations,
      0,
      'settled pre-reset behavior must stay discarded even without prior observation rows',
    );
    assert.equal(
      svc.view('B').growthReview?.eligibleObservations,
      6,
      'another Bot keeps its own evidence from the same matches',
    );
    // The fixture clock deliberately never advances: chronology comes from durable settlement identity.
    for (const id of new Set(old.map((o) => `new-${o.matchId}`))) svc.settle({ ...match(), id });
    svc.recordGrowthObservations(old.map((o) => ({ ...o, id: `new-${o.id}`, matchId: `new-${o.matchId}` })));
    assert.equal(svc.view('A').growthReview?.eligibleObservations, 6);
    svc.forget('A');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM growth_discarded_match WHERE bot = ?').get('A')?.n, 0);
  });

  test(`finished-game replay cannot restore observations discarded by ${action}, including new rows from the same match`, (t) => {
    const f = fixture(t);
    f.svc.ensureProfile('A');
    const old = observations();
    f.svc.recordGrowthObservations(old);
    if (action === 'reset') f.svc.resetGrowth('A');
    else f.svc.setTraits('A', { ...NEUTRAL, E: 0.8 });
    const svc = f.reopen();
    svc.recordGrowthObservations([...old, { ...old[0], id: 'late-observation' }]);
    assert.equal(svc.view('A').growthReview?.eligibleObservations, 0);
    svc.recordGrowthObservations(old.map((o) => ({ ...o, id: `new-${o.id}`, matchId: `new-${o.matchId}` })));
    assert.equal(svc.view('A').growthReview?.eligibleObservations, 6, 'new matches still accumulate normally');
  });
}

test('settlement report can be replayed after restart without repeating growth or relationships', (t) => {
  const f = fixture(t);
  f.svc.ensureProfile('A');
  const game = match();
  const recap = f.svc.settle(game);
  assert.ok(recap);
  const before = f.svc.view('A');
  const svc = f.reopen();
  assert.equal(svc.settle(game, { replayReport: true }), recap);
  assert.equal(svc.settle(game), undefined);
  assert.deepEqual(svc.view('A'), before);
  svc.forget('B');
  assert.doesNotMatch(svc.settle(game, { replayReport: true })!, /B（/);
  assert.deepEqual(svc.store.recentHighlights('B'), []);
});

for (const forgotten of [false, true]) {
  test(`fact episodes keep original seat numbers when an earlier member is forgotten=${forgotten}`, (t) => {
    const { svc } = fixture(t);
    svc.ensureProfile('A');
    const game = match();
    game.seats = [game.seats[2], game.seats[0], game.seats[1]];
    if (forgotten) svc.forget('C');
    svc.settle(game);
    assert.equal(svc.view('A').episodes[0].summary, '投票给 3 号，揭晓是狼人');
    if (forgotten) {
      assert.deepEqual(svc.view('C').highlights, []);
      assert.equal(svc.affinity('A', 'C'), 0);
    }
  });
}

for (const boundary of ['start', 'completion'] as const) {
  test(`growth audit write failure at ${boundary} is visible, preserves evidence and does not strand another Bot`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-write-failure-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A separate process verifies that an unhandled background rejection cannot terminate the application.
    const script = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { PersonaService } from ${JSON.stringify(new URL('../electron/core/persona/persona-service.ts', import.meta.url).href)};
      let now = 1000;
      const svc = new PersonaService(${JSON.stringify(dir)}, () => now);
      const db = new DatabaseSync(${JSON.stringify(join(dir, 'persona.sqlite'))});
      const batch = ${JSON.stringify(observations())};
      svc.ensureProfile('A');
      svc.ensureProfile('B');
      svc.recordGrowthObservations([...batch, ...batch.map(o => ({ ...o, botId: 'B', id: 'B-' + o.id }))]);
      db.exec(${JSON.stringify(`CREATE TRIGGER fail_audit BEFORE INSERT ON growth_review WHEN NEW.bot = 'A'${boundary === 'completion' ? " AND json_extract(NEW.json, '$.status') != 'running'" : ''} BEGIN SELECT RAISE(FAIL, 'audit write failure'); END`)});
      const text = JSON.stringify({ version: 1, summary: '行为稳定。', traits: Object.fromEntries(['E','A','C','N','O'].map(k => [k, { attribution: 'stable', direction: 0, reason: '未发现跨局变化。', evidence: [], counterEvidence: [] }])) });
      svc.configureGrowthReviewer({ available: () => true, ask: async () => ({ text }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(svc.view('A').growthReview.latest.status, 'failed');
      assert.equal(svc.view('A').growthReview.running, false);
      assert.match(svc.view('A').growthReview.latest.summary, /写入/);
      assert.equal(svc.view('A').growthReview.eligibleObservations, 6);
      assert.equal(svc.view('A').profile.n, 0);
      assert.equal(svc.view('B').growthReview.latest.status, 'unchanged');
      db.exec('DROP TRIGGER fail_audit');
      now += 1800000;
      svc.requestGrowthReview('A');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(svc.view('A').growthReview.latest.status, 'unchanged');
      assert.equal(svc.view('A').growthReview.eligibleObservations, 0);
      assert.ok(svc.view('A').growthReview.recent.some(r => r.status === 'failed'));
      svc.close();
      db.close();
      const reopened = new PersonaService(${JSON.stringify(dir)}, () => now);
      assert.equal(reopened.view('A').growthReview.latest.status, 'unchanged');
      assert.equal(reopened.view('A').profile.n, 0);
      reopened.close();
    `;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { stdio: 'pipe' });
  });
}
