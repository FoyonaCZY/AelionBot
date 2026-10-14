import test from 'node:test';
import assert from 'node:assert/strict';
import { seatAliases } from '../electron/core/games/prompt-seats';
import type { GameView } from '../shared/types/game-types';

const seats = ['露娜', '月', '林', '你'].map((name, i) => ({
  id: 's' + i,
  name,
  color: '#888',
  human: i === 3,
  alive: true,
})) as GameView['seats'];

test('seat names become seat numbers without breaking ordinary words', () => {
  const { alias } = seatAliases(seats);
  // The rules engine's own lines name seats exactly, so even one-character names are replaced.
  assert.equal(alias('月 投给 露娜。'), '2号玩家 投给 1号玩家。');
  // What players wrote keeps one-character names, which would otherwise break 赏月 and 树林.
  assert.equal(alias('中秋节赏月的时候在树林里，露娜很可疑', true), '中秋节赏月的时候在树林里，1号玩家很可疑');
  // Quoted words are never touched.
  assert.equal(alias('你的词是「月饼」。'), '你的词是「月饼」。');
  assert.equal(alias('我是你'), '我是你', 'the human is shown as 你 and never rewritten');
});
