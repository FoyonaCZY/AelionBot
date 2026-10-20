import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeKey, protocolRequest } from '../electron/core/model/model-protocol';
import type { ModelConfig, WireMessage } from '../shared/types/core';

const responses: ModelConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  contextTokens: 128000,
  protocol: 'responses',
  hasKey: true,
};
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  status: 'completed',
  content: [{ type: 'reasoning_text', text: '先看工程结构' }],
};
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{}' };
const answer = {
  type: 'message',
  id: 'msg_1',
  status: 'completed',
  content: [{ type: 'output_text', text: '合成完成' }],
};

const history = (cfg: ModelConfig, question = true): WireMessage[] => [
  { role: 'user', content: '做一个视频' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }],
    native: { protocol: 'responses', key: nativeKey(cfg), data: [reasoning, call] },
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  { role: 'assistant', content: '合成完成', native: { protocol: 'responses', key: nativeKey(cfg), data: [answer] } },
  ...(question ? [{ role: 'user' as const, content: '继续' }] : []),
  { role: 'system', content: '执行环境确认以下操作仍有未解决记录' },
];

const input = (messages: WireMessage[], cfg: ModelConfig) =>
  protocolRequest(cfg, messages, [], 4096, '', () => '').body as any;

test('a finished answer replayed for a follow-up is sent as context for DeepSeek thinking mode', () => {
  const body = input(history(responses, false), responses);
  assert.ok(!body.input.some((item: any) => item.id === 'msg_1'));
  assert.ok(!JSON.stringify(body.input).includes('"msg_1"'));
  const context = body.input.find((item: any) => item.role === 'system' && String(item.content).includes('合成完成'));
  assert.ok(context, 'the answer text stays available as a system note');
  assert.match(context.content, /此前的回答/);
  assert.ok(body.input.some((item: any) => item.type === 'function_call' && item.call_id === 'call_1'));
  assert.ok(body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_1'));
});

test('a new user input keeps the previous answer as a real assistant turn', () => {
  const body = input(history(responses, true), responses);
  assert.ok(body.input.some((item: any) => item.id === 'msg_1'));
  assert.ok(!body.input.some((item: any) => item.role === 'system' && String(item.content).includes('此前的回答')));
});

test('other providers keep the native assistant items untouched', () => {
  const other = { ...responses, model: 'gpt-5.1', baseUrl: 'https://api.openai.com/v1' },
    body = input(history(other, false), other);
  assert.ok(body.input.some((item: any) => item.id === 'msg_1'));
});

test('the chat protocol sends a finished answer as context when its reasoning is missing', () => {
  const chat: ModelConfig = { ...responses, protocol: 'chat' },
    messages: WireMessage[] = [
      { role: 'user', content: '做一个视频' },
      {
        role: 'assistant',
        content: '合成完成',
        native: { protocol: 'chat', key: nativeKey(chat), data: {} },
      },
      { role: 'system', content: '执行环境确认以下操作仍有未解决记录' },
    ],
    body = protocolRequest(chat, messages, [], 4096, '', () => '').body as any;
  const context = body.messages.find(
    (message: any) => message.role === 'system' && String(message.content).includes('此前的回答'),
  );
  assert.ok(context);
  assert.match(context.content, /合成完成/);
  assert.ok(!body.messages.some((message: any) => message.role === 'assistant' && message.content === '合成完成'));
});

test('a chat answer that carries reasoning stays an assistant turn', () => {
  const chat: ModelConfig = { ...responses, protocol: 'chat' },
    messages: WireMessage[] = [
      { role: 'user', content: '做一个视频' },
      {
        role: 'assistant',
        content: '合成完成',
        native: { protocol: 'chat', key: nativeKey(chat), data: { reasoning_content: '想过' } },
      },
      { role: 'user', content: '继续' },
    ],
    body = protocolRequest(chat, messages, [], 4096, '', () => '').body as any;
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].reasoning_content, '想过');
});
