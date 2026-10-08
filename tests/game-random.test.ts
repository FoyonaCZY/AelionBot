import test from 'node:test';
import assert from 'node:assert/strict';
import { createWerewolf, acceptAction, view, type WerewolfState } from '../electron/core/games/werewolf';
import { seededRandom } from '../shared/games/seeded-random';
import type { GameAction, GameRequest } from '../shared/types/game-types';

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), name: 'P' + i, human: false, color: '#888' }));
const answer = (r: GameRequest): GameAction =>
  ['speak', 'wolf_plan', 'campaign', 'pk_speak', 'last_words'].includes(r.kind)
    ? { text: '我先听听。' }
    : ['sheriff_join', 'withdraw'].includes(r.kind)
      ? { choice: false }
      : r.kind === 'witch'
        ? { potion: r.witch?.canSave ? 'save' : 'skip' }
        : r.kind === 'sheriff_order'
          ? { direction: 'clockwise' }
          : r.kind === 'badge' || r.kind === 'shoot'
            ? { skip: true }
            : r.targets.length
              ? { target: r.targets[r.targets.length - 1] }
              : { text: '我先听听。' };
function play(s: WerewolfState, each?: (before: WerewolfState, r: GameRequest, a: GameAction) => void) {
  let steps = 0;
  while (s.status === 'running' && s.requests.length && steps++ < 800) {
    const r = s.requests[0],
      a = answer(r);
    const before = structuredClone(s);
    acceptAction(s, r.id, a);
    each?.(
      before,
      before.requests.find((p) => p.id === r.id)!,
      a,
    );
  }
  return s;
}
const deal = (s: WerewolfState) => s.seats.map((p) => [p.role, p.mbti, p.personality, p.behaviorPolicy]);

test('seeded random is mulberry32: fixed sequence, no short cycle, roughly uniform', () => {
  const r = seededRandom(1);
  assert.deepEqual(
    [r.next(), r.next(), r.next()].map((x) => x.toFixed(6)),
    ['0.627074', '0.002736', '0.527447'],
  );
  const first = seededRandom(7),
    seen = new Set<number>();
  let sum = 0;
  for (let i = 0; i < 200_000; i++) {
    const x = first.next();
    sum += x;
    if (i < 50_000) seen.add(x);
  }
  // The old double-precision LCG repeated after ~10k draws (appendix C round 15).
  assert.ok(seen.size > 49_900, 'no short cycle');
  assert.ok(Math.abs(sum / 200_000 - 0.5) < 0.005, 'mean near 0.5');
});

test('the same seed deals the same match, and the same answers replay it exactly', () => {
  for (const [n, board] of [
    [7, undefined],
    [12, 'standard12'],
  ] as const) {
    const a = createWerewolf('g', players(n), undefined, board, 12345),
      b = createWerewolf('g', players(n), undefined, board, 12345);
    assert.equal(a.seed, 12345);
    assert.deepEqual(deal(a), deal(b));
    play(a);
    play(b);
    assert.equal(a.winner, b.winner);
    assert.deepEqual(
      a.logs.map((l) => l.text),
      b.logs.map((l) => l.text),
    );
    const deals = new Set(
      Array.from({ length: 20 }, (_, i) => JSON.stringify(deal(createWerewolf('g', players(n), undefined, board, i)))),
    );
    assert.ok(deals.size > 15, 'different seeds deal differently');
  }
  const live = createWerewolf('g', players(7));
  assert.equal(typeof live.seed, 'number', 'live matches still get a random seed, stored for replay');
  for (const viewer of [undefined, '0'])
    assert.ok(!('seed' in view(live, viewer)), 'the seed would reveal the deal, so no client sees it');
});
