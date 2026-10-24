import test from 'node:test';
import assert from 'node:assert/strict';
import { discardAdvice, fansOf, isWinning, shanten } from '../shared/games/mahjong-rules';
import { acceptMahjong, createMahjong, validateMahjong, viewMahjong } from '../electron/core/games/mahjong';
import { mahjongPrompt } from '../electron/core/games/mahjong-prompt';
import { checkActionContract } from '../electron/core/games/action-contract';
import { seededRandom } from '../shared/games/seeded-random';

const tiles = (text: string) => text.split(' ');
const players = (human = false) =>
  ['东家', '南家', '西家', '北家'].map((name, i) => ({ id: 'p' + i, name, color: '#887799', human: human && i === 0 }));

test('winning hands: four sets and a pair, seven pairs, and with melds', () => {
  assert.ok(isWinning(tiles('1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 1s 1s 5p 5p')));
  assert.ok(isWinning(tiles('1m 1m 3m 3m 5m 5m 7s 7s 9p 9p E E C C')));
  assert.ok(isWinning(tiles('2m 3m 4m 5p 5p'), 3));
  assert.ok(!isWinning(tiles('1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 1s 1s 5p 6p')));
  assert.ok(!isWinning(tiles('8m 9m 1s 2s 3s 4s 5s 6s 7s 8s 9s E E E')), 'no wrap from 9m to 1s');
});

test('tiles from ready counts down to a ready hand', () => {
  assert.equal(shanten(tiles('1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 1s 1s 5p')), 0);
  assert.equal(shanten(tiles('1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 1s 5p 9p')), 1);
  assert.equal(shanten(tiles('1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 1s 1s 5p 5p')), -1);
  const advice = discardAdvice(tiles('1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 1s 1s 5p 9p'), 0, []);
  const best = advice.find((a) => a.tile === '9p')!;
  assert.equal(best.shanten, 0);
  assert.deepEqual(best.useful, ['5p']);
  assert.equal(best.count, 3);
});

test('fan: patterns add up from the base', () => {
  const names = (f: { name: string }[]) => f.map((x) => x.name);
  assert.deepEqual(
    names(
      fansOf({
        tiles: tiles('1m 1m 1m 2m 2m 2m 5m 5m 5m 9m 9m'),
        melds: [{ kind: 'peng', tile: '3m' }],
        selfDrawn: true,
      }),
    ),
    ['平胡', '碰碰胡', '清一色', '自摸'],
  );
  assert.deepEqual(
    names(fansOf({ tiles: tiles('1m 1m 3m 3m 5m 5m 7s 7s 9p 9p E E C C'), melds: [], selfDrawn: false })),
    ['平胡', '七对', '门清'],
  );
});

function playOut(seed: number) {
  const s = createMahjong('g', players(), {}, seed);
  const random = seededRandom(seed + 1);
  let steps = 0;
  while (s.status === 'running' && steps++ < 2000) {
    assert.ok(s.requests.length, 'a running hand always waits for someone');
    for (const r of s.requests.slice()) {
      // Win when offered, pass most claims, and discard what the advice says brings the hand closest.
      const advice = discardAdvice(s.hands[r.seatId], s.melds[r.seatId].length, []).sort(
        (x, y) => x.shanten - y.shanten || y.count - x.count,
      );
      const action = r.targets.includes('hu')
        ? { target: 'hu' }
        : r.canPass
          ? random.next() < 0.7
            ? { skip: true }
            : { target: r.targets[random.int(r.targets.length)] }
          : { target: random.next() < 0.8 ? `d:${advice[0].tile}` : r.targets[random.int(r.targets.length)] };
      validateMahjong(s, r, action);
      checkActionContract(action, r);
      acceptMahjong(s, r.id, action);
      if (s.status !== 'running') break;
    }
  }
  return s;
}

test('random hands end in a win or a draw, every tile accounted for', () => {
  let wins = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const s = playOut(seed);
    assert.equal(s.status, 'finished');
    if (s.winner === 'hu') {
      wins++;
      const w = s.win!;
      assert.ok(isWinning(s.hands[w.seatId], s.melds[w.seatId].length));
      assert.equal(
        Object.values(s.scores!).reduce((a, b) => a + b, 0),
        0,
      );
    } else assert.equal(s.wall.length, 0);
    const melded = Object.values(s.melds)
      .flat()
      .reduce((n, m) => n + (m.kind === 'peng' ? 3 : 4), 0);
    assert.equal(
      s.wall.length + Object.values(s.hands).flat().length + Object.values(s.discards).flat().length + melded,
      136,
    );
  }
  assert.ok(wins > 0);
});

test('a seat sees its own tiles only, and each discard carries its advice', () => {
  const s = createMahjong('g', players(true), {}, 9);
  const r = s.requests[0];
  const view = viewMahjong(s, r.seatId);
  assert.equal(view.tiles!.hand!.length, 14);
  assert.equal(view.tiles!.hands, undefined);
  assert.ok(r.options!.filter((o) => o.id.startsWith('d:')).every((o) => o.hint));
  // The tile just drawn is the first discard, which a timeout plays.
  assert.equal(r.options!.find((o) => o.id.startsWith('d:'))!.id, `d:${view.tiles!.drawn}`);
  const prompt = JSON.parse(mahjongPrompt(view, r));
  assert.equal(prompt.request.options.length, r.options!.length);
  assert.throws(() => validateMahjong(s, r, { skip: true }), /必须打出/);
});
