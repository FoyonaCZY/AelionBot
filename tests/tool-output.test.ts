import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactToolResult,
  readPageLimit,
  toolResultEnvelope,
  toolResultLimit,
} from '../electron/core/tools/tool-output';
import { toolResult, technicalOutput } from '../shared/chat/activity';
import type { ChatMessage } from '../shared/types/core';

test('large command output keeps exit code, stderr tail and structure instead of a JSON prefix', () => {
  const stdout = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  const output = {
    stdout,
    stderr: 'x'.repeat(20000) + '\nFAILED: expected 2 received 3',
    exitCode: 1,
    durationMs: 12,
    truncated: false,
  };
  const envelope = JSON.parse(toolResultEnvelope('exec', '11111111-1111-1111-1111-111111111111', output, 8000));
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.readWith, 'read_result');
  assert.equal(envelope.resultId, '11111111-1111-1111-1111-111111111111');
  assert.ok(JSON.stringify(envelope).length <= 8000 + 300);
  assert.equal(envelope.result.exitCode, 1);
  assert.equal(envelope.result.durationMs, 12);
  // Logs keep more of their end, where failures are reported.
  assert.match(envelope.result.stderr, /FAILED: expected 2 received 3$/);
  assert.match(envelope.result.stdout, /line 3999$/);
  assert.match(envelope.result.stdout, /^line 0\n/);
  assert.match(envelope.result.stdout, /省略中间 \d+ 字符/);
});

test('small results are unchanged and file pages keep sha256 and paging fields', () => {
  const page = { content: 'const a = "b";\n', sha256: 'a'.repeat(64), nextOffset: 15, eof: true };
  assert.deepEqual(JSON.parse(toolResultEnvelope('e', 'r', page, 8000)).result, page);
  const big = { ...page, content: 'x'.repeat(50000), eof: false, nextOffset: 50000 };
  const compact = compactToolResult(big, 6000);
  assert.equal(compact.truncated, true);
  assert.equal((compact.value as any).sha256, page.sha256);
  assert.equal((compact.value as any).nextOffset, 50000);
  assert.equal((compact.value as any).eof, false);
  assert.ok(JSON.stringify(compact.value).length <= 6000);
});

test('many small items are trimmed by count and the result stays within budget', () => {
  const matches = Array.from({ length: 3000 }, (_, i) => ({ path: `src/file-${i}.ts`, line: i + 1, text: 'match' }));
  const compact = compactToolResult({ matches, eof: false }, 5000),
    value = compact.value as any;
  assert.ok(JSON.stringify(value).length <= 5000);
  assert.equal(value.eof, false);
  assert.equal(value.matches[0].path, 'src/file-0.ts');
  assert.match(String(value.matches.at(-1)), /省略 \d+ 项/);
});

test('budgets scale with the model window and default read pages fit inline', () => {
  assert.equal(toolResultLimit(32000), 6000);
  assert.equal(toolResultLimit(128000), 12800);
  assert.equal(toolResultLimit(1_000_000), 24000);
  for (const tokens of [8000, 32000, 128000, 200000, 1_000_000]) {
    assert.ok(readPageLimit(tokens) < toolResultLimit(tokens));
    assert.ok(readPageLimit(tokens) <= 12000);
  }
});

test('the UI still recognizes truncated envelopes and renders their compact result', () => {
  const content = toolResultEnvelope(
    'e',
    '22222222-2222-2222-2222-222222222222',
    { stdout: 'y'.repeat(30000), exitCode: 0 },
    6000,
  );
  const message = {
    id: 'm',
    botId: 'b',
    role: 'tool',
    content,
    time: '2026-09-25T00:00:00Z',
    tool: 'exec_command',
  } as ChatMessage;
  const value = toolResult(message) as any;
  assert.equal(value.truncated, true);
  assert.match(value.preview, /"exitCode": 0/);
  assert.match(technicalOutput(message), /部分输出/);
});
