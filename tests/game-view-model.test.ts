import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameLog, GameView } from '../shared/types/game-types';
import {
  matchMinutes,
  periodOf,
  personalClues,
  phaseSteps,
  reportTimeline,
  seatFate,
  transcriptItems,
} from '../src/group/game-view-model';

const names = [
  '你',
  '设计师克',
  '格洛克',
  '程序员奇洛',
  '小鲸鱼',
  '大鲸鱼',
  '七七',
  '中鲸鱼',
  '克劳德',
  '咕噜猫',
  '卢娜',
  '露娜',
];
let id = 0;
const log = (text: string, extra: Partial<GameLog> = {}): GameLog => ({
  id: ++id,
  day: 1,
  phase: 'vote',
  text,
  time: 1_000_000 + id * 60_000,
  ...extra,
});
function game(logs: GameLog[], extra: Partial<GameView> = {}): GameView {
  return {
    id: 'g',
    groupId: 'group',
    board: 'standard12',
    day: 1,
    phase: 'vote',
    status: 'running',
    humanId: 's1',
    pending: [],
    logs,
    seats: names.map((name, i) => ({ id: `s${i + 1}`, name, color: '#888', human: i === 0, alive: true })),
    ...extra,
  };
}

test('the phase bar marks steps done, current and next, with the election only on day one', () => {
  assert.deepEqual(
    phaseSteps(game([], { phase: 'election' })).map((s) => `${s.key}:${s.state}`),
    ['night:done', 'election:now', 'speech:next', 'vote:next'],
  );
  assert.deepEqual(
    phaseSteps(game([], { day: 2, phase: 'speech' })).map((s) => s.key),
    ['night', 'speech', 'vote'],
  );
  assert.equal(
    phaseSteps(game([], { phase: 'resolution', stage: '放逐结算' })).find((s) => s.state === 'now')?.key,
    'vote',
  );
  assert.equal(periodOf({ phase: 'night', status: 'running' }), 'night');
  assert.equal(periodOf({ phase: 'vote', status: 'finished' }), 'finished');
});

test('consecutive vote lines become one tally with 1.5 sheriff weight and abstentions', () => {
  const items = transcriptItems(
    game([
      log('开始放逐投票，警长计 1.5 票。'),
      log('程序员奇洛 投给 你（1.5 票）。'),
      log('设计师克 投给 你（1 票）。'),
      log('格洛克 投给 程序员奇洛（1 票）。'),
      log('大鲸鱼 弃票。'),
      log('你 被放逐。'),
    ]),
  );
  assert.deepEqual(
    items.map((item) => item.kind),
    ['log', 'tally', 'log'],
  );
  const tally = items[1] as Extract<(typeof items)[number], { kind: 'tally' }>;
  assert.deepEqual(
    tally.rows.map((row) => [row.target.name, row.total, row.voters.map((v) => v.weight)]),
    [
      ['你', 2.5, [1.5, 1]],
      ['程序员奇洛', 1, [1]],
    ],
  );
  assert.deepEqual(
    tally.abstain.map((seat) => seat.name),
    ['大鲸鱼'],
  );
});

test('a speech that happens to contain "投给" is never mistaken for a vote', () => {
  const items = transcriptItems(game([log('我建议大家投给 7 号。', { seatId: 's2', phase: 'speech' })]));
  assert.equal(items[0].kind, 'log');
});

test('only the human own private results count as clues; another player private line in omniscient view does not', () => {
  const clues = personalClues(
    game([
      log('查验结果：七七 是狼人。', { scope: 'personal', phase: 'night' }),
      log('【小鲸鱼 · 私有记录】小鲸鱼使用解药救下了 咕噜猫。', { scope: 'personal', phase: 'night' }),
      log('天亮了，咕噜猫 出局。', { scope: 'shared' }),
    ]),
  );
  assert.deepEqual(
    clues.map((clue) => clue.text),
    ['查验结果：七七 是狼人。'],
  );
});

test('fates, the report timeline and duration are read from shared log lines', () => {
  const logs = [
    log('程序员奇洛 当选警长，获得警徽。', { phase: 'election' }),
    log('天亮了，咕噜猫 出局。', { phase: 'resolution' }),
    log('查验结果：七七 是狼人。', { scope: 'personal', phase: 'night' }),
    log('猎人 咕噜猫 开枪，格洛克 出局。', { phase: 'resolution' }),
    log('你 被放逐。', { day: 2 }),
    log('狼人全部出局，好人阵营获胜。', { day: 4, phase: 'finished' }),
  ];
  const g = game(logs, { status: 'finished', phase: 'finished', winner: 'village' });
  for (const name of ['你', '格洛克', '咕噜猫']) g.seats.find((s) => s.name === name)!.alive = false;
  const fate = (name: string) =>
    seatFate(
      g,
      g.seats.find((s) => s.name === name)!,
    );
  assert.deepEqual(fate('你'), { day: 2, text: '被放逐' });
  assert.deepEqual(fate('格洛克'), { day: 1, text: '被猎人带走' });
  // The hunter is named in the shot line but died at night, not by their own shot.
  assert.deepEqual(fate('咕噜猫'), { day: 1, text: '夜里出局' });
  assert.equal(fate('卢娜'), undefined);
  assert.ok(!reportTimeline(g).some((entry) => entry.text.includes('查验结果')));
  assert.equal(reportTimeline(g).length, 5);
  assert.equal(matchMinutes(g), 5);
});
