import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../shared/types/core';
import type { RunStep } from '../shared/chat/activity';
import { sameMentions, sameMessage, sameSteps } from '../src/chat/render-equality';

const message = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, botId: 'b', role: 'assistant', content, time: '2026-09-29T10:00:00Z', ...extra }) as ChatMessage;

test('a structured-clone snapshot of unchanged messages and steps compares equal', () => {
  const steps: RunStep[] = [
    { kind: 'tool', id: 't', message: message('t', '{"result":1}', { role: 'tool', tool: 'host_file_read' }) },
    {
      kind: 'reasoning',
      id: 'r',
      message: message('r', '', { reasoning: { text: '想一想', durationMs: 900 } } as any),
    },
  ];
  assert.equal(sameSteps(steps, structuredClone(steps)), true);
  assert.equal(sameMessage(steps[0].message, structuredClone(steps[0].message)), true);
  assert.equal(sameMentions([{ id: 'x', name: 'X' }] as any, [{ id: 'x', name: 'X' }] as any), true);
});

test('any field a step or message renders makes the comparison fail', () => {
  const base = message('m', '回答', { status: 'running', attachments: [{ id: 'f', name: 'a.md', size: 1 }] } as any);
  for (const change of [
    { status: 'done' },
    { content: '新回答' },
    { attachments: [] },
    { pins: [{ emoji: '👍' }] },
    { reasoning: { text: 'x' } },
  ] as Array<Partial<ChatMessage>>)
    assert.equal(sameMessage(base, { ...structuredClone(base), ...change }), false, JSON.stringify(change));
  const steps: RunStep[] = [{ kind: 'note', id: 'm', message: base }];
  assert.equal(sameSteps(steps, []), false);
  assert.equal(sameSteps(steps, [{ kind: 'reasoning', id: 'm', message: base }]), false);
  assert.equal(sameMentions([{ id: 'x', name: 'X' }] as any, [{ id: 'x', name: 'Y' }] as any), false);
});
