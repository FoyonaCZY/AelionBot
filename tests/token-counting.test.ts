import test from 'node:test';
import assert from 'node:assert/strict';
import { getEncoding } from 'js-tiktoken';
import type { WireMessage } from '../shared/types/core';
import {
  historySourceHash,
  messageSourceHash,
  messageTokens,
  serializeForSummary,
  sourceHash,
} from '../electron/core/context/context-budget';
import { TokenCountCache } from '../electron/core/context/token-count-cache';
import { runTokenJob } from '../electron/core/context/token-jobs';
import { primeTokenCounts, summaryInput } from '../electron/core/context/token-counter';

const exact = (text: string) => getEncoding('o200k_base').encode(text, [], []).length;
const history = (count: number, size: number): WireMessage[] =>
  Array.from({ length: count }, (_, i) =>
    i % 3 === 2
      ? { role: 'tool', tool_call_id: `c${i}`, content: `{"result":"${'输出内容 data '.repeat(size / 10)}"}` }
      : {
          role: i % 3 ? 'assistant' : 'user',
          content: `第 ${i} 条：${'这是一段较长的中文说明，with some English words and code() calls. '.repeat(size / 40)}`,
          ...(i % 3 === 1
            ? {
                tool_calls: [
                  { id: `c${i + 1}`, type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
                ],
              }
            : {}),
        },
  );

test('a summary input that is said to fit really fits, counted exactly', () => {
  for (const [count, size, budget] of [
    [12, 400, 4000],
    [60, 2000, 6000],
    [300, 3000, 20000],
  ]) {
    const result = serializeForSummary(history(count, size), budget);
    const tokens = exact(result.text);
    if (result.fits) assert.ok(tokens <= budget, `${count}×${size}: ${tokens} > ${budget}`);
    // Conservative, but only by the seams between items: clearly fitting input is not turned away.
    else assert.ok(tokens > budget * 0.9, `${count}×${size}: ${tokens} of ${budget} judged too large`);
  }
  const small = serializeForSummary(history(6, 100), 50000);
  assert.equal(small.fits, true);
  assert.equal(small.abbreviated, false);
});

test('a history far over budget is judged without counting all of it', () => {
  const long = history(2000, 4000);
  const started = performance.now();
  const result = serializeForSummary(long, 30000);
  assert.equal(result.fits, false);
  // Counting every abbreviated item of this history takes several seconds; stopping at the budget does not.
  assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
});

test('token jobs and their in-place fallback give the same results as direct calls', async () => {
  const messages = history(9, 200);
  assert.deepEqual(runTokenJob({ kind: 'count', texts: ['', 'abc', '中文'] }), [0, exact('abc'), exact('中文')]);
  assert.deepEqual(await summaryInput(messages, 5000), serializeForSummary(messages, 5000));
  await primeTokenCounts(messages);
});

test('a growing history hashes exactly like serializing it whole', () => {
  const live = history(30, 300);
  const check = (length = live.length) =>
    assert.equal(historySourceHash(live, length), sourceHash(live.slice(0, length)), `length ${length}`);
  check(0);
  check(10);
  check();
  live.push(...history(5, 100));
  check(30);
  check();
  live[3] = { ...live[3], content: 'replaced' };
  check();
  check(12);
  live.length = 20;
  check();
  const single = live[7];
  assert.equal(messageSourceHash(single), sourceHash([single]));
  assert.equal(messageSourceHash(single), messageSourceHash(single));
});

test('a cached message count follows a changed field', () => {
  const message: WireMessage = { role: 'user', content: '短的内容' };
  const before = messageTokens(message);
  message.content = '更长的一段内容，'.repeat(20);
  assert.ok(messageTokens(message) > before);
  assert.equal(messageTokens(message), 5 + exact(message.content!));
});

test('counts made elsewhere are remembered, and only uncounted texts are reported', () => {
  let encodes = 0;
  const cache = new TokenCountCache((text) => {
    encodes++;
    return text.length;
  }, 4);
  cache.count('known');
  const missing = cache.unknown(['known', 'new', 'new', '', 'other']);
  assert.deepEqual(
    missing.map((entry) => entry.text),
    ['new', 'other'],
  );
  cache.remember(missing[0].key, 42);
  assert.equal(cache.count('new'), 42);
  assert.equal(encodes, 1);
});
