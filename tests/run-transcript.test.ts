import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleRunSteps, type RunStep } from '../shared/chat/activity';
import type { ChatMessage } from '../shared/types/core';

let sequence = 0;
const message = (patch: Partial<ChatMessage>): ChatMessage =>
  ({
    id: `m${++sequence}`,
    botId: 'bot',
    role: 'tool',
    content: '',
    time: '2026-10-21T00:00:00.000Z',
    ...patch,
  }) as ChatMessage;

const tool = (): RunStep => ({
  kind: 'tool',
  id: `t${++sequence}`,
  message: message({ role: 'tool', tool: 'file_read' }),
});
const note = (text = '中间输出'): RunStep => ({
  kind: 'note',
  id: `n${++sequence}`,
  message: message({ role: 'assistant', content: text }),
});

test('a running transcript keeps every note and only the newest tools', () => {
  const notes = [note('一'), note('二')],
    steps = [...Array.from({ length: 10 }, tool), ...notes],
    result = visibleRunSteps(steps, { running: true, expanded: false });
  assert.equal(result.hiddenTools, 2);
  assert.equal(result.steps.filter((step) => step.kind === 'note').length, 2);
  assert.equal(result.steps.filter((step) => step.kind === 'tool').length, 8);
  assert.deepEqual(
    result.steps.map((step) => step.id),
    [...steps.slice(0, 0), ...steps.slice(2)].map((step) => step.id),
  );
});

test('notes are never truncated, even when they are the oldest steps', () => {
  const steps = [note('很早的输出'), ...Array.from({ length: 12 }, tool)],
    result = visibleRunSteps(steps, { running: true, expanded: false });
  assert.equal(result.hiddenTools, 4);
  assert.equal(result.steps[0].id, steps[0].id);
});

test('an expanded running transcript stops limiting tools', () => {
  const steps = Array.from({ length: 12 }, tool),
    result = visibleRunSteps(steps, { running: true, expanded: true });
  assert.equal(result.hiddenTools, 0);
  assert.equal(result.steps.length, 12);
});

test('a finished run shows nothing until it is expanded', () => {
  const steps = [note(), tool()];
  assert.deepEqual(visibleRunSteps(steps, { running: false, expanded: false }), { steps: [], hiddenTools: 0 });
  assert.deepEqual(visibleRunSteps(steps, { running: false, expanded: true }), { steps, hiddenTools: 0 });
});

test('an empty transcript stays empty in every state', () => {
  assert.deepEqual(visibleRunSteps([], { running: true, expanded: false }), { steps: [], hiddenTools: 0 });
  assert.deepEqual(visibleRunSteps([], { running: false, expanded: true }), { steps: [], hiddenTools: 0 });
});
