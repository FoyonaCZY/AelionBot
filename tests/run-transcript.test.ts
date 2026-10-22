import test from 'node:test';
import assert from 'node:assert/strict';
import { runOverview, visibleRunSteps, type RunStep } from '../shared/chat/activity';
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
const reasoning = (): RunStep => ({
  kind: 'reasoning',
  id: `r${++sequence}`,
  message: message({ role: 'assistant' }),
});
const note = (text = '中间输出'): RunStep => ({
  kind: 'note',
  id: `n${++sequence}`,
  message: message({ role: 'assistant', content: text }),
});

test('a running transcript keeps every note and only the newest three other steps', () => {
  const notes = [note('一'), note('二')],
    steps = [...Array.from({ length: 10 }, tool), ...notes],
    result = visibleRunSteps(steps, { running: true, expanded: false });
  assert.equal(result.hiddenSteps, 7);
  assert.equal(result.steps.filter((step) => step.kind === 'note').length, 2);
  assert.equal(result.steps.filter((step) => step.kind === 'tool').length, 3);
  assert.deepEqual(
    result.steps.map((step) => step.id),
    steps.slice(7).map((step) => step.id),
  );
});

test('thinking rows count against the three-step limit instead of flooding the transcript', () => {
  const steps = [...Array.from({ length: 5 }, reasoning), note(), tool()],
    result = visibleRunSteps(steps, { running: true, expanded: false });
  assert.equal(result.hiddenSteps, 3);
  assert.equal(result.steps.filter((step) => step.kind === 'reasoning').length, 2);
  assert.equal(result.steps.filter((step) => step.kind === 'note').length, 1);
  assert.equal(result.steps.filter((step) => step.kind === 'tool').length, 1);
});

test('notes are never truncated, even when they are the oldest steps', () => {
  const steps = [note('很早的输出'), ...Array.from({ length: 12 }, tool)],
    result = visibleRunSteps(steps, { running: true, expanded: false });
  assert.equal(result.hiddenSteps, 9);
  assert.equal(result.steps[0].id, steps[0].id);
});

test('an expanded running transcript stops limiting its other steps', () => {
  const steps = Array.from({ length: 12 }, tool),
    result = visibleRunSteps(steps, { running: true, expanded: true });
  assert.equal(result.hiddenSteps, 0);
  assert.equal(result.steps.length, 12);
});

test('a finished run shows nothing until it is expanded', () => {
  const steps = [note(), tool()];
  assert.deepEqual(visibleRunSteps(steps, { running: false, expanded: false }), { steps: [], hiddenSteps: 0 });
  assert.deepEqual(visibleRunSteps(steps, { running: false, expanded: true }), { steps, hiddenSteps: 0 });
});

test('an empty transcript stays empty in every state', () => {
  assert.deepEqual(visibleRunSteps([], { running: true, expanded: false }), { steps: [], hiddenSteps: 0 });
  assert.deepEqual(visibleRunSteps([], { running: false, expanded: true }), { steps: [], hiddenSteps: 0 });
});

const toolStep = (tool: string, patch: Partial<ChatMessage> = {}): RunStep => ({
  kind: 'tool',
  id: `t${++sequence}`,
  message: message({ role: 'tool', tool, ...patch }),
});

test('a folded run line names the kinds of work in the order the run first did them', () => {
  const overview = runOverview([
    toolStep('file_read', { activity: { label: '读取文件', detail: 'a.ts' } }),
    toolStep('exec_command'),
    note(),
    toolStep('file_read', { activity: { label: '读取文件', detail: 'b.ts · 第 40 行起' } }),
    toolStep('file_read', { activity: { label: '读取文件', detail: 'a.ts · 第 90 行起' } }),
  ]);
  assert.deepEqual(overview.parts, ['读取了 2 个文件', '运行了 1 条命令']);
});

test('a folded run line adds up changed lines and keeps the images read, not computer screens', () => {
  const overview = runOverview([
    toolStep('apply_patch', { diff: { files: [{ path: 'a', added: 3, removed: 1 }] } } as Partial<ChatMessage>),
    toolStep('file_patch', { diff: { files: [{ path: 'b', added: 2, removed: 0 }] } } as Partial<ChatMessage>),
    toolStep('view_image', { screenshotId: 'img-1' }),
    toolStep('computer', { screenshotId: 'screen-1' }),
    toolStep('attachment_read', { screenshotId: 'img-2' }),
  ]);
  assert.equal(overview.added, 5);
  assert.equal(overview.removed, 1);
  assert.deepEqual(overview.images, ['img-1', 'img-2']);
});

test('a run without tools has no kinds to name', () => {
  assert.deepEqual(runOverview([note(), reasoning()]).parts, []);
});

test('a folded running transcript keeps only the run text', () => {
  const steps = [tool(), note(), reasoning(), tool()],
    result = visibleRunSteps(steps, { running: true, expanded: false, stepLimit: 0 });
  assert.deepEqual(
    result.steps.map((step) => step.kind),
    ['note'],
  );
});
