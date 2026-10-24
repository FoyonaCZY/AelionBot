import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, until } from './helpers';
import { GameRuntime, type Decide } from '../electron/core/games/runtime';
import { parseGameAction } from '../electron/core/games/model-player';
import { checkActionContract } from '../electron/core/games/action-contract';
import { gameMode } from '../electron/core/games/modes';
import type { GameRequest } from '../shared/types/game-types';

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: '玩家' + i, color: '#887799', human: false }));
/** A model that answers like a real one: JSON text with a pick, a note and a line of table talk, whether asked or not. */
const instructions: string[] = [];
const decide: Decide = async (_player, context, request) => {
  instructions.push(gameMode(context.mode).instructions(context, request));
  return parseGameAction(
    JSON.stringify({ target: request.targets[0], note: '先出小牌', text: '这把我来' }),
    request.kind,
    request,
    context.seats,
  );
};

test('Dou Di Zhu runs through the runtime: models bid, the landlord takes the hole cards, plays and talk land', async (t) => {
  const runtime = new GameRuntime(tempDir(t), decide);
  t.after(() => runtime.dispose());
  const created = runtime.create({ groupId: 'g', mode: 'doudizhu', players: players(3), tableTalk: true });
  assert.equal(created.mode, 'doudizhu');
  await until(() => (runtime.read('g', true)?.logs.filter((l) => / 出 /.test(l.text)).length || 0) >= 3, {
    timeoutMs: 20000,
  });
  const view = runtime.read('g', true)!;
  assert.ok(view.cards!.landlordId);
  assert.equal(view.seats.find((p) => p.id === view.cards!.landlordId)!.role, 'landlord');
  assert.ok(
    view.logs.some((l) => l.seatId && l.text === '这把我来'),
    'table talk is logged as the seat speaking',
  );
  // Full view shows every hand; the public view of an all-AI match shows none.
  assert.ok(view.cards!.hands);
  assert.equal(runtime.read('g')!.cards!.hands, undefined);
});

test('Mahjong runs through the runtime: the dealer draws, discards go round and claims are only asked when legal', async (t) => {
  const runtime = new GameRuntime(tempDir(t), decide);
  t.after(() => runtime.dispose());
  runtime.create({ groupId: 'g', mode: 'mahjong', players: players(4) });
  await until(() => (runtime.read('g', true)?.logs.filter((l) => / 打出 /.test(l.text)).length || 0) >= 6, {
    timeoutMs: 20000,
  });
  const view = runtime.read('g', true)!;
  const discarded = Object.values(view.tiles!.discards).flat().length;
  assert.ok(discarded >= 1);
  assert.equal(
    view.tiles!.wall + Object.values(view.tiles!.counts).reduce((a, b) => a + b, 0),
    136 - discarded - meldTiles(view.tiles!.melds),
  );
});
const meldTiles = (melds: Record<string, { kind: string }[]>) =>
  Object.values(melds)
    .flat()
    .reduce((n, m) => n + (m.kind === 'peng' ? 3 : 4), 0);

test('table talk is off unless the match turns it on: the model is not told it may speak, and its talk is dropped', async (t) => {
  for (const mode of ['doudizhu', 'mahjong'] as const) {
    const runtime = new GameRuntime(tempDir(t), decide);
    t.after(() => runtime.dispose());
    instructions.length = 0;
    runtime.create({ groupId: 'g', mode, players: players(mode === 'doudizhu' ? 3 : 4) });
    await until(() => instructions.length >= 4, { timeoutMs: 20000 });
    await until(() => (runtime.read('g', true)?.logs.length || 0) >= 4, { timeoutMs: 20000 });
    const view = runtime.read('g', true)!;
    assert.ok(
      view.logs.every((l) => !l.seatId),
      `${mode}: no seat speaks at the table`,
    );
    assert.ok(
      instructions.every((i) => !i.includes('闲聊')),
      `${mode}: the model is never offered table talk`,
    );
  }
});

test('a model that is still thinking when the clock runs out makes the timeout move, like a person', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const asked: string[] = [];
  // Never answers: holds the request until the runtime gives up on it.
  const silent: Decide = (_player, _context, request, signal) => {
    asked.push(request.id);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const runtime = new GameRuntime(tempDir(t), silent);
  t.after(() => runtime.dispose());
  const created = runtime.create({ groupId: 'g', mode: 'doudizhu', players: players(3) });
  assert.equal(created.clock!.totalMs, 60000, 'a model bids on twice the time of a person');
  assert.ok(created.clock!.deadlineAt, 'the bidding model is on the clock');
  await until(() => asked.length === 1);
  t.mock.timers.tick(31000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(asked.length, 1, 'the time of a person is not up for a model');
  t.mock.timers.tick(30000);
  await until(() => asked.length === 2);
  const view = runtime.read('g', true)!;
  assert.equal(view.status, 'running', 'the match goes on instead of pausing');
  assert.equal(Object.values(view.cards!.bids).length, 1);
  assert.equal(Object.values(view.cards!.bids)[0], 0, 'a late bid is a pass');
  const timeout = runtime.inspect(created.id).find((e) => e.type === 'timeout');
  assert.equal(timeout?.detail, '模型思考超时，按超时规则自动行动');
});

test('a model that keeps giving unusable moves makes the timeout move once out of attempts', async (t) => {
  const tries: string[] = [];
  const wrong: Decide = async (_player, _context, request) => {
    tries.push(request.id);
    return { target: 'nothing-like-this' };
  };
  const runtime = new GameRuntime(tempDir(t), wrong);
  t.after(() => runtime.dispose());
  const created = runtime.create({ groupId: 'g', mode: 'mahjong', players: players(4) });
  await until(() => (runtime.read('g', true)?.logs.some((l) => l.text.includes('超时自动摸切')) ? true : false));
  const view = runtime.read('g', true)!;
  assert.equal(view.status, 'running');
  assert.equal(tries.filter((id) => id === tries[0]).length, 3, 'three tries at the same move');
  assert.ok(runtime.inspect(created.id).some((e) => e.type === 'timeout' && e.detail?.includes('多次未给出可用行动')));
});

test('card moves take one listed option, a pass only where passing is allowed, and short table talk', () => {
  const lead: GameRequest = {
    id: 'r',
    seatId: 's',
    talk: true,
    kind: 'play',
    targets: ['p1', 'p2'],
    options: [
      { id: 'p1', label: '单张 3', cards: ['3'] },
      { id: 'p2', label: '对子 44', cards: ['4', '4'] },
    ],
  };
  checkActionContract({ target: 'p2', text: '起飞' }, lead);
  assert.throws(() => checkActionContract({ skip: true }, lead));
  assert.throws(() => checkActionContract({ target: 'p9' }, lead));
  checkActionContract({ skip: true }, { ...lead, canPass: true });
  const long = parseGameAction(JSON.stringify({ target: 'p1', text: '话'.repeat(60) }), 'play', lead);
  assert.equal(long.text!.length, 30, 'overlong table talk is cut, not refused');
  assert.match(long.formatNote!, /截断/);
  // Without talk the field does not exist: a model that sends it anyway has it dropped, not the move refused.
  const quiet = { ...lead, talk: undefined };
  assert.throws(() => checkActionContract({ target: 'p1', text: '我听牌了' }, quiet));
  const dropped = parseGameAction(JSON.stringify({ target: 'p1', text: '我听牌了' }), 'play', quiet);
  assert.equal(dropped.text, undefined);
  assert.equal(dropped.target, 'p1');
});
