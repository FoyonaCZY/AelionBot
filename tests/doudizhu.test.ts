import test from 'node:test';
import assert from 'node:assert/strict';
import { beats, classify, deck, legalPlays, rankOf, sortCards } from '../shared/games/doudizhu-rules';
import { acceptDoudizhu, createDoudizhu, validateDoudizhu, viewDoudizhu } from '../electron/core/games/doudizhu';
import { doudizhuPrompt } from '../electron/core/games/doudizhu-prompt';
import { checkActionContract } from '../electron/core/games/action-contract';
import { seededRandom } from '../shared/games/seeded-random';

const play = (ranks: string) => classify(ranks.split(' '));
const players = (human = false) =>
  ['甲', '乙', '丙'].map((name, i) => ({ id: 'p' + i, name, color: '#887799', human: human && i === 0 }));

test('combinations are recognised by rank, and only the legal ones', () => {
  assert.equal(play('7')?.type, 'single');
  assert.equal(play('7 7 7 3')?.type, 'triple_single');
  assert.equal(play('7 7 7 3 3')?.type, 'triple_pair');
  assert.equal(play('3 4 5 6 7')?.type, 'straight');
  assert.equal(play('10 J Q K A')?.type, 'straight');
  assert.equal(play('J Q K A 2'), undefined, '2 never joins a straight');
  assert.equal(play('3 3 4 4 5 5')?.type, 'pair_chain');
  assert.equal(play('3 3 4 4'), undefined, 'a pair chain needs three pairs');
  assert.equal(play('3 3 3 4 4 4 9 J')?.type, 'plane_single');
  assert.equal(play('3 3 3 4 4 4 9 9 J J')?.type, 'plane_pair');
  assert.equal(play('6 6 6 6 3 9')?.type, 'four_two');
  assert.equal(play('6 6 6 6 3 3 9 9')?.type, 'four_pairs');
  assert.equal(play('8 8 8 8')?.type, 'bomb');
  assert.equal(play('小王 大王')?.type, 'rocket');
  assert.equal(play('3 4'), undefined);
});

test('a play beats only its own type and size, bombs beat the rest and the rocket beats all', () => {
  assert.ok(beats(play('4 4')!, play('3 3')!));
  assert.ok(!beats(play('3 3')!, play('4 4')!));
  assert.ok(!beats(play('4 5 6 7 8 9')!, play('3 4 5 6 7')!), 'a longer straight is a different play');
  assert.ok(beats(play('3 3 3 3')!, play('2 2')!));
  assert.ok(beats(play('5 5 5 5')!, play('4 4 4 4')!));
  assert.ok(beats(play('小王 大王')!, play('2 2 2 2')!));
  assert.ok(!beats(play('2 2 2 2')!, play('小王 大王')!));
});

test('the legal plays from a hand all hold up and follow the play to beat', () => {
  const random = seededRandom(7);
  for (let round = 0; round < 50; round++) {
    const cards = deck();
    for (let i = cards.length - 1; i > 0; i--) {
      const j = random.int(i + 1);
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    const hand = sortCards(cards.slice(0, 17));
    const free = legalPlays(hand);
    assert.ok(free.length >= 10 && free.length < 400, `${free.length} plays`);
    for (const option of free) {
      assert.deepEqual(classify(option.ranks), option.play);
      // Every play can be made from the hand.
      const left = hand.map(rankOf);
      for (const rank of option.ranks) left.splice(left.indexOf(rank), 1);
      assert.equal(left.length, hand.length - option.ranks.length);
    }
    const lead = play('5 5')!;
    for (const option of legalPlays(hand, lead)) assert.ok(beats(option.play, lead));
  }
});

/** Plays a whole match with a seeded random pick among the legal moves, always passing when it may half the time. */
function playOut(seed: number, human = false) {
  const s = createDoudizhu('g', players(human), {}, seed);
  const random = seededRandom(seed + 1);
  let steps = 0;
  while (s.status === 'running' && steps++ < 400) {
    const r = s.requests[0];
    assert.ok(r, 'a running match always waits for someone');
    const action =
      r.canPass && (random.next() < 0.4 || !r.targets.length)
        ? { skip: true }
        : { target: r.targets[random.int(r.targets.length)] };
    validateDoudizhu(s, r, action);
    checkActionContract(action, r);
    acceptDoudizhu(s, r.id, action);
  }
  return s;
}

test('random matches always finish with one side out of cards and scores that add up', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const s = playOut(seed);
    assert.equal(s.status, 'finished');
    assert.ok(s.landlordId);
    const winner = s.seats.find((p) => !s.hands[p.id].length)!;
    assert.equal(s.winner, winner.id === s.landlordId ? 'landlord' : 'farmer');
    assert.equal(
      Object.values(s.scores!).reduce((a, b) => a + b, 0),
      0,
    );
    // Every card is somewhere: in a hand or played.
    assert.equal(Object.values(s.hands).flat().length + s.played.length, 54);
  }
});

test('a seat sees its own cards and counts only, and the prompt lists the plays by id', () => {
  const s = createDoudizhu('g', players(true), {}, 3);
  const view = viewDoudizhu(s, 'p0');
  assert.equal(view.cards!.hand!.length, 17);
  assert.equal(view.cards!.hands, undefined);
  assert.deepEqual(Object.values(view.cards!.counts), [17, 17, 17]);
  const r = s.requests[0];
  const other = viewDoudizhu(s, r.seatId);
  const prompt = JSON.parse(doudizhuPrompt(other, r));
  assert.equal(prompt.request.kind, 'bid');
  assert.ok(prompt.request.options.every((o: { id: string }) => r.targets.includes(o.id)));
  assert.ok(!JSON.stringify(prompt).includes(s.hands[s.seats.find((p) => p.id !== r.seatId)!.id].join(' ')));
});

test('leading cannot pass, and a timeout plays the lowest card', () => {
  const s = createDoudizhu('g', players(), {}, 11);
  while (s.phase === 'bid') acceptDoudizhu(s, s.requests[0].id, { target: s.requests[0].targets.at(-1) });
  const r = s.requests[0];
  assert.equal(r.canPass, false);
  assert.throws(() => validateDoudizhu(s, r, { skip: true }), /不能不要/);
  const before = s.hands[r.seatId].length;
  acceptDoudizhu(s, r.id, { skip: true }, true);
  assert.equal(s.hands[r.seatId].length, before - 1);
});

test('nobody bidding three times makes the first bidder landlord at one point', () => {
  const s = createDoudizhu('g', players(), {}, 5);
  for (let i = 0; i < 9 && s.phase === 'bid'; i++) acceptDoudizhu(s, s.requests[0].id, { skip: true });
  assert.equal(s.phase, 'play');
  assert.equal(Math.max(...Object.values(s.bids)), 1);
  assert.equal(s.hands[s.landlordId!].length, 20);
});
