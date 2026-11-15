import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverTextToolCalls } from '../electron/core/model/text-tool-calls';
import type { ToolDefinition } from '../electron/core/model/model';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'group_read',
      description: '',
      parameters: { type: 'object', properties: { groupId: { type: 'string' }, limit: { type: 'number' } } },
    },
  },
];
const reply = (content: string, extra = {}) => ({ content, calls: [], finishReason: 'stop', ...extra });

test('a tool call written as text in the Qwen/GLM markup becomes a real call and leaves the reply', () => {
  const result = recoverTextToolCalls(
    reply(
      '<tool_call><function=group_read><parameter=groupId>72b6ce78</parameter><parameter=limit>20</parameter></function>',
    ),
    tools,
  );
  assert.equal(result.content, '', 'nothing of the markup is published');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.calls[0].function.name, 'group_read');
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { groupId: '72b6ce78', limit: 20 });
});

test('the Hermes JSON form is recovered too, and prose around it stays', () => {
  const result = recoverTextToolCalls(
    reply('我先看看记录。\n<tool_call>\n{"name": "group_read", "arguments": {"groupId": "g1"}}\n</tool_call>'),
    tools,
  );
  assert.equal(result.content, '我先看看记录。');
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { groupId: 'g1' });
});

test('markup for a tool that was not offered, or beside native calls, is removed but never run', () => {
  const unknown = recoverTextToolCalls(
    reply('好的<tool_call><function=rm_rf><parameter=path>/</parameter></function></tool_call>'),
    tools,
  );
  assert.deepEqual([unknown.content, unknown.calls.length, unknown.finishReason], ['好的', 0, 'stop']);
  const native = { id: 'n1', type: 'function' as const, function: { name: 'group_read', arguments: '{}' } };
  const both = recoverTextToolCalls(
    reply('<tool_call>{"name": "group_read", "arguments": {}}</tool_call>', {
      calls: [native],
      finishReason: 'tool_calls',
    }),
    tools,
  );
  assert.deepEqual(both.calls, [native], 'a native call is not doubled');
  assert.equal(both.content, '');
  const plain = reply('普通的回复');
  assert.equal(recoverTextToolCalls(plain, tools), plain);
});

const dsml = (body: string) => `<｜DSML｜function_calls>\n${body}\n</｜DSML｜function_calls>`;

test('a DeepSeek call written as text runs as a call, its text kept as written and its JSON read', () => {
  const command = String.raw`Get-ChildItem -Path 'D:\Games' -Filter "*.cs" | Select-Object -ExpandProperty FullName`;
  const result = recoverTextToolCalls(
    reply(
      '先找一下文件。\n' +
        dsml(
          '<｜DSML｜invoke name="group_read">\n' +
            `<｜DSML｜parameter name="groupId" string="true">${command}</｜DSML｜parameter>\n` +
            '<｜DSML｜parameter name="limit" string="false">20</｜DSML｜parameter>\n' +
            '</｜DSML｜invoke>',
        ),
      // Chat Completions keeps only the reasoning as its own replay, so the recovered calls go back with the text.
      { native: { protocol: 'chat', key: 'k', data: { reasoning_content: '想一想' } } },
    ),
    tools,
  );
  assert.equal(result.content, '先找一下文件。');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { groupId: command, limit: 20 });
});

test('DeepSeek markup is removed without running when the call is unknown or the provider replays its own blocks', () => {
  const call = dsml('<｜DSML｜invoke name="group_read"><｜DSML｜parameter name="groupId">g1</｜DSML｜parameter>');
  const replayed = recoverTextToolCalls(
    reply('好的' + call, { native: { protocol: 'anthropic', key: 'k', data: [] } }),
    tools,
  );
  assert.deepEqual([replayed.content, replayed.calls.length, replayed.finishReason], ['好的', 0, 'stop']);
  const unknown = recoverTextToolCalls(reply(call.replace('group_read', 'rm_rf') + '\n完成'), tools);
  assert.deepEqual([unknown.content, unknown.calls.length], ['完成', 0]);
});
