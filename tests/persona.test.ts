import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settleMatch, type SettleMatch } from '../electron/core/persona/settle';
import { PersonaService, affinityScore } from '../electron/core/persona/persona-service';
import { createWerewolf, acceptAction, view } from '../electron/core/games/werewolf';
import { gamePrompt } from '../electron/core/games/model-player';
import { BOARDS } from '../shared/games/game-boards';
import type { GameAction, GameRequest } from '../shared/types/game-types';

const DAY = 86_400_000;
function tempDir(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Close the service before removing its folder: Windows cannot delete an open SQLite file.
function personaService(t: test.TestContext, now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona-'));
  const svc = new PersonaService(dir, now);
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
// Seats: a (wolf, Bot A), b (wolf, Bot B), c (witch, Bot C), d (villager, human), e (villager, guest).
const match = (over: Partial<SettleMatch> = {}): SettleMatch => ({
  id: 'm1',
  groupId: 'g1',
  winner: 'village',
  seats: [
    { id: 'a', name: '1号', human: false, botId: 'A', role: 'wolf' },
    { id: 'b', name: '2号', human: false, botId: 'B', role: 'wolf' },
    { id: 'c', name: '3号', human: false, botId: 'C', role: 'witch' },
    { id: 'd', name: '4号', human: true, role: 'villager' },
    { id: 'e', name: '5号', human: false, role: 'villager' },
  ],
  events: [],
  ...over,
});

test('settlement records only unusual events and leaves temporary guests out', () => {
  const r = settleMatch(
    match({
      events: [
        { type: 'exile', day: 1, seatId: 'a', voters: ['b', 'd', 'e'] }, // wolf a exiled with wolf b's vote
        { type: 'exile', day: 2, seatId: 'b', voters: ['c', 'd'] }, // normal play: the other camp votes a wolf out
        { type: 'save', day: 2, witchId: 'c', seatId: 'd' }, // the witch saves the human, who has no Bot to settle
      ],
    }),
  )!;
  const teammate = r.affinity.filter((x) => x.source.endsWith('exiled_by_teammate'));
  assert.deepEqual(
    teammate.map((x) => [x.botId, x.targetId, x.value]),
    [['A', 'B', -0.4]],
  );
  assert(!r.affinity.some((x) => x.botId === 'B' && x.value < 0), 'being exiled by the other camp is not a grudge');
  assert(!r.affinity.some((x) => x.source.endsWith('saved_by_witch')), 'the human is saved but has no Bot to settle');
  // Village won: C (witch) is on the winning side with the human d and guest e; only Bot C gets a teammate bonus.
  assert.deepEqual(
    r.affinity.filter((x) => x.source.endsWith('won_together')).map((x) => [x.botId, x.targetId]),
    [['C', 'user']],
  );
  assert(r.highlights.some((h) => h.botId === 'A' && h.type === 'exiled_by_teammate' && h.participants.includes('B')));
  assert.equal(r.highlights.filter((h) => h.type === 'match').length, 3, 'one match memory per seated Bot');
  assert.match(r.recap, /好人阵营获胜/);
  assert.match(r.recap, /1号 被同阵营的 2号 投票放逐/);
});

test('a saved Bot remembers the witch, and a stopped match is not settled', () => {
  const r = settleMatch(match({ events: [{ type: 'save', day: 1, witchId: 'c', seatId: 'b' }] }))!;
  assert.deepEqual(
    r.affinity.filter((x) => x.source.endsWith('saved_by_witch')).map((x) => [x.botId, x.targetId, x.value]),
    [['B', 'C', 0.3]],
  );
  assert.equal(settleMatch(match({ winner: undefined })), undefined);
});

test('affinity decays linearly, weighs bad more than good, and is clipped', () => {
  const now = 100 * DAY;
  const mod = (value: number, ageDays: number, days = 30) => ({
    id: 'x',
    botId: 'A',
    targetId: 'B',
    value,
    createdAt: now - ageDays * DAY,
    durationDays: days,
    source: 's',
  });
  assert.equal(affinityScore([mod(0.3, 0)], now), 0.3);
  assert.ok(Math.abs(affinityScore([mod(0.3, 15)], now) - 0.15) < 1e-9);
  assert.equal(affinityScore([mod(0.3, 30)], now), 0);
  assert.ok(Math.abs(affinityScore([mod(-0.4, 0)], now) + 0.6) < 1e-9, 'negative × (1 + N), N = 0.5');
  assert.equal(affinityScore([mod(-0.9, 0), mod(-0.9, 0)], now), -1);
});

test('persona service settles once, recalls a memory once per cooldown, and forgets on request', (t) => {
  let clock = 1_000 * DAY;
  const svc = personaService(t, () => clock);
  const m = match({ events: [{ type: 'exile', day: 1, seatId: 'a', voters: ['b', 'd'] }] });
  assert.match(svc.settle(m)!, /狼人杀战报/);
  assert.equal(svc.settle(m), undefined, 'the same match is settled only once');
  assert.ok(svc.affinity('A', 'B') < -0.15);
  const first = svc.groupFragment('A', [{ id: 'B', name: 'Bot B' }]);
  assert.match(first, /你和Bot B的关系很差/, '−0.4 × (1 + N) = −0.6');
  assert.match(first, /被同阵营的 2号 投票放逐|一局狼人杀/);
  const second = svc.groupFragment('A', [{ id: 'B', name: 'Bot B' }]);
  assert.notEqual(first, second, 'the recalled memory is on cooldown the next time');
  clock += 8 * DAY;
  assert.match(svc.groupFragment('A', [{ id: 'B', name: 'Bot B' }]), /你们之间发生过的事/);
  assert.equal(svc.groupFragment('A', [{ id: 'A', name: 'self' }]), '', 'a Bot has no relation line to itself');
  svc.forget('B');
  assert.equal(svc.affinity('A', 'B'), 0);
  assert.doesNotMatch(svc.groupFragment('A', [{ id: 'B', name: 'Bot B' }]), /发生过的事/);
});

test('a match without seated Bots posts no report', (t) => {
  const svc = personaService(t);
  const noBots = match();
  noBots.seats = noBots.seats.map((s) => ({ ...s, botId: undefined }));
  assert.equal(svc.settle(noBots), undefined);
});

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    name: 'P' + i,
    human: false,
    color: '#888',
    botId: 'bot' + i,
  }));
function play(n: number, board?: 'standard12') {
  const s = createWerewolf('g', players(n), board ? BOARDS[board].roles : undefined, board);
  const answer = (r: GameRequest): GameAction =>
    ['speak', 'wolf_plan', 'campaign', 'pk_speak', 'last_words'].includes(r.kind)
      ? { text: '我先听听。', note: `座位${r.seatId}的${r.kind}打算` }
      : ['sheriff_join', 'withdraw'].includes(r.kind)
        ? { choice: false, note: '先不表态' }
        : r.kind === 'witch'
          ? { potion: r.witch?.canSave ? 'save' : 'skip', note: '救人' }
          : r.kind === 'sheriff_order'
            ? { direction: 'clockwise' }
            : r.kind === 'badge' || r.kind === 'shoot'
              ? { skip: true }
              : r.targets.length
                ? { target: r.targets[0], note: `座位${r.seatId}的${r.kind}打算` }
                : { text: '我先听听。', note: `座位${r.seatId}的${r.kind}打算` };
  let steps = 0;
  while (s.status === 'running' && s.requests.length && steps++ < 800)
    acceptAction(s, s.requests[0].id, answer(s.requests[0]));
  return s;
}

test('the engine records exiles with voters and saves, and keeps each seat three latest notes', () => {
  for (const [n, board] of [
    [7, undefined],
    [12, 'standard12'],
  ] as const) {
    const s = play(n, board);
    assert.equal(s.status, 'finished', `${n}-player match finishes`);
    const exiles = (s.events || []).filter((e) => e.type === 'exile');
    assert.ok(exiles.length > 0, `${n}-player match records exiles`);
    for (const e of exiles) assert.ok(e.type === 'exile' && e.voters.length > 0 && !e.voters.includes(e.seatId));
    assert.ok(
      (s.events || []).some((e) => e.type === 'save'),
      `${n}-player witch save is recorded`,
    );
    for (const [seatId, notes] of Object.entries(s.notes || {})) {
      assert.ok(notes.length <= 3);
      assert.deepEqual(view(s, seatId).notes, notes, 'a seat sees its own notes');
    }
    assert.ok(
      s.seats.every((p) => p.botId?.startsWith('bot')),
      'botId survives seating',
    );
  }
});

test('a decision prompt includes only the deciding seat notes', () => {
  const s = play(7);
  const [a, b] = Object.keys(s.notes || {});
  assert.ok(a && b);
  const prompt = JSON.parse(gamePrompt(view(s, a), { id: 'r', seatId: a, kind: 'vote', targets: [] }));
  assert.equal(prompt.context.personal.notes.length, s.notes![a].length);
  assert.ok(!JSON.stringify(prompt).includes(JSON.stringify(s.notes![b])), 'other seats notes never leak');
});

test('the runtime reports a finished match once, with each seat Bot and the engine events', async () => {
  const { GameRuntime } = await import('../electron/core/games/runtime');
  const { until } = await import('./helpers');
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona-rt-'));
  const finished: import('../electron/core/games/werewolf').WerewolfState[] = [];
  const runtime = new GameRuntime(
    dir,
    async (_p, _v, r) =>
      r.kind === 'wolf_plan' || r.kind === 'speak'
        ? { text: '我先听这轮的具体说法。', note: '先观察。' }
        : r.kind === 'witch'
          ? { potion: 'skip' }
          : { target: r.targets[0], note: '选择当前目标。' },
    () => {},
    { aiTimeoutMs: 90000 },
    {
      finished: (s) => {
        finished.push(s);
      },
    },
  );
  try {
    runtime.create({
      groupId: 'g',
      players: Array.from({ length: 7 }, (_, i) => ({
        id: 'seat' + i,
        name: 'P' + i,
        human: false,
        color: '#888',
        ...(i < 3 ? { botId: 'bot' + i } : {}),
      })),
    });
    await until(() => finished.length > 0, { timeoutMs: 25_000, intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(finished.length, 1, 'reported exactly once');
    const s = finished[0];
    assert.ok(s.winner);
    assert.deepEqual(
      s.seats
        .map((p) => p.botId)
        .filter(Boolean)
        .sort(),
      ['bot0', 'bot1', 'bot2'],
      'botId is kept; guests have none',
    );
    assert.ok(
      s.seats.every((p) => !p.id.startsWith('seat')),
      'seat ids are still randomized',
    );
    assert.ok((s.events || []).some((e) => e.type === 'exile'));
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forget removes owned memories as well as memories mentioning the deleted Bot', (t) => {
  const dir = tempDir(t);
  const svc = new PersonaService(dir);
  svc.settle(match());
  svc.settle(match({ id: 'unrelated', seats: match().seats.filter((s) => s.botId !== 'A') }));
  svc.forget('A');
  assert.deepEqual(svc.store.recentHighlights('A'), []);
  assert.equal(svc.groupFragment('A', [{ id: 'B', name: 'B' }]), '');
  assert.ok(svc.store.recentHighlights('B').every((h) => !h.participants.includes('A')));
  assert.ok(svc.store.recentHighlights('B').some((h) => h.sourceId === 'unrelated'));
  svc.close();
  const reopened = new PersonaService(dir);
  try {
    assert.deepEqual(reopened.store.recentHighlights('A'), []);
  } finally {
    reopened.close();
  }
});

for (const guarded of [true, false]) {
  test(`witch settlement records a rescue only when the victim survives (guarded=${guarded})`, () => {
    const s = createWerewolf('g', players(12), BOARDS.guard12.roles, 'guard12', 123);
    let steps = 0;
    while (s.phase !== 'speech' && steps++ < 100) {
      const r = s.requests[0];
      assert.ok(r);
      let action: GameAction;
      if (r.kind === 'wolf_plan' || r.kind === 'last_words') action = { text: '我先听听。' };
      else if (r.kind === 'guard') action = { target: guarded ? '4' : '5' };
      else if (r.kind === 'kill') action = { target: '4' };
      else if (r.kind === 'inspect') action = { target: '0' };
      else if (r.kind === 'witch') action = { potion: 'save' };
      else if (r.kind === 'sheriff_join') action = { choice: false };
      else assert.fail(`unexpected request: ${r.kind}`);
      acceptAction(s, r.id, action);
    }
    assert.equal(s.phase, 'speech');
    assert.equal(s.seats[4].alive, !guarded);
    assert.equal(s.potions!.save, false, 'the potion is spent in both cases');
    const result = settleMatch({ ...s, winner: 'wolves', events: s.events || [] })!;
    assert.equal(
      result.affinity.some((a) => a.source.endsWith('saved_by_witch')),
      !guarded,
    );
    assert.equal(
      result.highlights.some((h) => h.type === 'saved_by_witch'),
      !guarded,
    );
    if (guarded) assert.doesNotMatch(result.recap, /救下/);
  });
}

test('a match finishing after deletion cannot restore the forgotten Bot or its relationships, even after restart', (t) => {
  const dir = tempDir(t);
  let svc = new PersonaService(dir);
  svc.ensureProfile('A');
  svc.forget('A');
  svc.close();
  svc = new PersonaService(dir);
  try {
    svc.settle(match({ winner: 'wolves' }));
    assert.deepEqual(svc.store.recentHighlights('A'), []);
    assert.deepEqual(svc.store.affinityTargets('A'), []);
    assert.equal(svc.affinity('B', 'A'), 0);
    assert.ok(svc.store.recentHighlights('B').every((h) => !h.participants.includes('A')));
    assert.throws(() => svc.ensureProfile('A'));
  } finally {
    svc.close();
  }
});
