import test from 'node:test';
import assert from 'node:assert/strict';
import { settleMatch } from '../electron/core/persona/settle';
import type { MatchFacts } from '../electron/core/persona/match-facts';

// A game the persona module has never heard of: every seat is its own team, as in a guessing game.
const facts = (over: Partial<MatchFacts> = {}): MatchFacts => ({
  id: 'm1',
  groupId: 'g1',
  game: '你说我猜',
  seats: [
    { id: 'a', name: 'Bot A', human: false, botId: 'A', team: 'a', role: '玩家' },
    { id: 'b', name: 'Bot B', human: false, botId: 'B', team: 'b', role: '玩家' },
    { id: 'u', name: '你', human: true, team: 'u', role: '玩家' },
  ],
  winners: ['b'],
  result: 'Bot B 得分最高',
  social: [],
  experiences: [],
  ...over,
});
const clue = {
  type: 'aid' as const,
  name: 'clue_guessed',
  key: '{from} 的提示让 {to} 猜中',
  highlight: '{from} 的提示让你猜中',
};

test('settlement works from facts alone, for a game without camps', () => {
  const r = settleMatch(facts({ social: [{ ...clue, from: 'a', to: 'b' }] }))!;
  assert.deepEqual(
    r.affinity.map((x) => [x.botId, x.targetId, x.value, x.source]),
    [['B', 'A', 0.3, 'match:m1:clue_guessed']],
    'helping is remembered; one-person teams never win together',
  );
  assert.equal(
    r.recap,
    '你说我猜战报：Bot B 得分最高。\n身份：Bot A（玩家）、Bot B（玩家）、你（玩家）。\n关键事件：Bot A 的提示让 Bot B 猜中。',
  );
  assert.ok(
    r.highlights.some((h) => h.botId === 'B' && h.type === 'clue_guessed' && h.summary === 'Bot A 的提示让你猜中'),
  );
  assert.ok(
    r.highlights.some(
      (h) => h.botId === 'B' && h.type === 'match' && h.summary.startsWith('一局你说我猜：你是玩家，赢了'),
    ),
  );
  assert.ok(r.highlights.some((h) => h.botId === 'A' && h.type === 'match' && h.summary.includes('输了')));
});

test('affinity from the same help between the same players counts once per match', () => {
  const r = settleMatch(
    facts({
      social: [
        { ...clue, from: 'a', to: 'b' },
        { ...clue, from: 'a', to: 'b' },
        { ...clue, from: 'b', to: 'a' },
      ],
    }),
  )!;
  assert.deepEqual(
    r.affinity.map((x) => [x.botId, x.targetId]),
    [
      ['B', 'A'],
      ['A', 'B'],
    ],
  );
  assert.equal(r.highlights.filter((h) => h.type === 'clue_guessed').length, 3, 'every occurrence is remembered');
});

test('a cooperative game: one team, everyone wins or loses together', () => {
  const together = (winners?: string[]) =>
    settleMatch(facts({ winners, seats: facts().seats.map((s) => ({ ...s, team: 'all' })) }));
  assert.deepEqual(
    together(['all'])!.affinity.map((x) => [x.botId, x.targetId, x.value]),
    [
      ['A', 'B', 0.1],
      ['A', 'user', 0.1],
      ['B', 'A', 0.1],
      ['B', 'user', 0.1],
    ],
  );
  assert.equal(together(undefined), undefined, 'a match stopped without a result is not settled');
});

test('a forgotten member is never named in what others remember', () => {
  const vote = {
    type: 'ally_vote' as const,
    name: 'voted_by_teammate',
    to: 'a',
    from: ['b', 'gone'],
    key: '{to} 被队友 {from} 投出',
    highlight: '你被队友 {from} 投出',
  };
  const r = settleMatch(facts({ social: [vote] }))!;
  assert.match(r.recap, /Bot A 被队友 Bot B 投出/);
  assert.doesNotMatch(r.recap, /gone/);
  assert.equal(settleMatch(facts({ social: [{ ...vote, from: ['gone'] }] }))!.recap.includes('投出'), false);
});
