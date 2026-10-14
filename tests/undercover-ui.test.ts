import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { registerHooks } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { acceptUndercover, createUndercover, viewUndercover } from '../electron/core/games/undercover';
import type { GameView } from '../shared/types/game-types';

const pairs = { pairs: [{ id: 'u001', a: '牛奶', b: '豆浆', category: '食物饮品' }], version: 'test' };
const players = Array.from({ length: 6 }, (_, i) => ({
  id: 'p' + i,
  name: '玩家' + i,
  color: '#887799',
  human: i === 0,
}));
// Components import their stylesheets; the server render needs none of them.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css') ? { format: 'module', shortCircuit: true, source: '' } : next(url, context),
});
const { UndercoverTable } = await import('../src/group/UndercoverTable');
const render = (game: GameView) =>
  renderToStaticMarkup(
    createElement(UndercoverTable, {
      game,
      onUpdate: () => {},
      onMutationStart: () => {},
      syncError: '',
      omniscient: false,
      onOmniscient: () => {},
      onClose: () => {},
    }),
  );

test('the table shows the human only their own word, and the description box on their turn', () => {
  // Find a seed where the human describes first.
  let s = createUndercover('g', players, {}, 1, pairs);
  for (let seed = 2; s.requests[0].seatId !== 'p0'; seed++) s = createUndercover('g', players, {}, seed, pairs);
  const own = s.seats[0].role === 'civilian' ? s.words.civilian : s.words.undercover;
  const other = own === '牛奶' ? '豆浆' : '牛奶';
  const html = render(viewUndercover(s, 'p0'));
  assert.ok(html.includes(own));
  assert.ok(!html.includes(other), 'the other word never reaches the human');
  assert.match(html, /谁是卧底/);
  assert.match(html, /提交描述/);
  assert.match(html, /maxLength="60"/);
});

test('the report names the winner and both words', () => {
  const s = createUndercover('g', players, {}, 3, pairs);
  const spy = s.seats.find((p) => p.role === 'undercover')!.id;
  while (s.requests[0]?.kind === 'describe') acceptUndercover(s, s.requests[0].id, { text: '常见的饮品' });
  for (const r of Array.from(s.requests))
    acceptUndercover(s, r.id, r.seatId === spy ? { skip: true } : { target: spy });
  const html = render(viewUndercover(s, 'p0'));
  assert.match(html, /平民获胜/);
  assert.ok(html.includes('牛奶') && html.includes('豆浆'));
});
