import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { ModelClient } from '../electron/core/model/model';
import { protocolRequest, StreamAccumulator, nativeKey } from '../electron/core/model/model-protocol';
import { modelEventActivity } from '../electron/core/model/model-stream';
import { modelParameters } from '../electron/core/model/model-providers';
import { hiddenClientTools } from '../electron/core/tools/hosted-tools';
import type { ModelConfig } from '../shared/types/core';
import type { ToolDefinition } from '../electron/core/model/model';

const tool = (name: string): ToolDefinition => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const claude: ModelConfig = {
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-test',
  hasKey: true,
  contextTokens: 200000,
  protocol: 'anthropic',
};
async function server(t: test.TestContext, handler: RequestListener) {
  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return `http://127.0.0.1:${(s.address() as any).port}/v1`;
}
const sse = (events: unknown[]) => events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');

test('Claude hosted web search replaces the client web_search tool in the request', () => {
  const tools = [tool('web_search'), tool('web_read')];
  const hosted = protocolRequest(
    { ...claude, hostedWebSearch: true },
    [{ role: 'user', content: 'q' }],
    tools,
    4096,
    'k',
    () => '',
  );
  const body = hosted.body as any;
  assert.equal(hosted.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(body.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  assert.deepEqual(
    body.tools.map((item: any) => item.name),
    ['web_search', 'web_read'],
  );
  assert.equal(body.tools.filter((item: any) => item.input_schema).length, 1);
  const plain = protocolRequest(claude, [{ role: 'user', content: 'q' }], tools, 4096, 'k', () => '').body as any;
  assert.ok(plain.tools.every((item: any) => item.input_schema));
  assert.deepEqual(hiddenClientTools({ protocol: 'anthropic', hostedWebSearch: true }), new Set(['web_search']));
  assert.deepEqual(hiddenClientTools({ protocol: 'chat', hostedWebSearch: true }), new Set());
});

test('provider parameters keep hosted search for Claude and Responses only', () => {
  assert.equal(modelParameters({ protocol: 'anthropic', hostedWebSearch: true }).hostedWebSearch, true);
  assert.equal(modelParameters({ protocol: 'responses', hostedWebSearch: true }).hostedWebSearch, true);
  assert.equal(modelParameters({ protocol: 'gemini', hostedWebSearch: true }).hostedWebSearch, undefined);
  assert.equal(
    modelParameters({ protocol: 'anthropic', hostedImageGeneration: true }).hostedImageGeneration,
    undefined,
  );
});

test('server tool blocks are kept for replay, never executed locally, and count as progress', () => {
  const parser = new StreamAccumulator('anthropic', nativeKey(claude), () => {});
  const start = {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
  };
  const result = {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 's1',
      content: [
        { type: 'web_search_result', url: 'https://example.com', title: 'Example', encrypted_content: 'opaque' },
      ],
    },
  };
  for (const event of [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    start,
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"aelion"}' } },
    { type: 'content_block_stop', index: 0 },
    result,
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Found it.' } },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.com' } },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])
    parser.consume(event);
  const done = parser.result();
  assert.equal(done.content, 'Found it.');
  assert.deepEqual(done.calls, []);
  const blocks = done.native!.data as any[];
  assert.deepEqual(blocks[0].input, { query: 'aelion' });
  assert.equal(blocks[1].content[0].encrypted_content, 'opaque');
  assert.equal(blocks[2].citations.length, 1);
  assert.equal(modelEventActivity('anthropic', start)?.kind, 'response');
  assert.equal(modelEventActivity('anthropic', result)?.kind, 'response');
  // The replayed assistant turn carries the provider blocks unchanged.
  const replay = protocolRequest(
    claude,
    [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: done.content, native: done.native },
      { role: 'user', content: 'more' },
    ],
    [],
    4096,
    'k',
    () => '',
  ).body as any;
  assert.equal(replay.messages[1].content[0].type, 'server_tool_use');
  assert.equal(replay.messages[1].content[1].content[0].encrypted_content, 'opaque');
});

test('a paused server-tool turn is resumed with its own content and merged into one reply', async (t) => {
  const bodies: any[] = [];
  const baseUrl = await server(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse(
        bodies.length === 1
          ? [
              { type: 'message_start', message: { usage: { input_tokens: 10 } } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'a' } },
              },
              { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 3 } },
              { type: 'message_stop' },
            ]
          : [
              { type: 'message_start', message: { usage: { input_tokens: 20 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
              { type: 'message_stop' },
            ],
      ),
    );
  });
  const model = new ModelClient(
    () => ({ ...claude, baseUrl, hostedWebSearch: true }),
    () => '',
  );
  t.after(() => model.dispose());
  const result = await model.complete([{ role: 'user', content: 'search' }], [], new AbortController().signal);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].messages.at(-1), {
    role: 'assistant',
    content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'a' } }],
  });
  assert.equal(result.content, 'answer');
  assert.equal(result.finishReason, 'end_turn');
  assert.equal(result.usage?.outputTokens, 7);
  assert.deepEqual(
    (result.native!.data as any[]).map((block) => block.type),
    ['server_tool_use', 'text'],
  );
});
