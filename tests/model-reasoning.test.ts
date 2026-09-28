import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protocolRequest, StreamAccumulator, nativeKey } from '../electron/core/model/model-protocol';
import { ModelClient, assistantMessage, type Completion } from '../electron/core/model/model';
import { ReplyStreams } from '../electron/core/agent/reply-streams';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import type { VmController } from '../electron/core/vm/vm';
import type { ModelConfig } from '../shared/types/core';
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../shared/preview/appearance';
import { taggedReasoning } from '../shared/chat/activity';
import { until } from './helpers';

const cfg: ModelConfig = { baseUrl: 'http://localhost:1/v1', model: 'test', hasKey: false, contextTokens: 32000 };
// Tags are escaped so the reasoning markers never appear literally in this file.
const OPEN = '\x3cthink>',
  CLOSE = '\x3c/think>';

function parse(protocol: ModelConfig['protocol'] & string, events: any[]) {
  const updates: string[] = [];
  const parser = new StreamAccumulator(
    protocol,
    nativeKey({ ...cfg, protocol }),
    () => {},
    (text) => updates.push(text),
  );
  for (const event of events) parser.consume(event);
  return { result: parser.result(), updates };
}

test('Claude thinking deltas become readable reasoning without entering the reply text', () => {
  const { result, updates } = parse('anthropic', [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先查数据，' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再汇总。' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '结果如下。' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: '补一句。' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]);
  assert.equal(result.content, '结果如下。');
  assert.equal(result.reasoning, '先查数据，再汇总。\n\n补一句。');
  assert.equal(updates[0], '先查数据，');
  // Reasoning text is display-only; the signed native block is what goes back to the model.
  assert.ok(!('reasoning' in assistantMessage(result)));
  assert.equal((result.native!.data as any[])[0].signature, 'sig');
});

test('Responses summaries stream as reasoning and a JSON response falls back to its reasoning items', () => {
  const streamed = parse('responses', [
    { type: 'response.reasoning_summary_part.added' },
    { type: 'response.reasoning_summary_text.delta', delta: '第一段摘要' },
    { type: 'response.reasoning_summary_part.added' },
    { type: 'response.reasoning_summary_text.delta', delta: '第二段摘要' },
    // The same reasoning under a second field is not appended twice.
    { type: 'response.reasoning_text.delta', delta: '重复的原文' },
    { type: 'response.output_text.delta', delta: '好的' },
    { type: 'response.completed', response: { output: [], usage: {} } },
  ]);
  assert.equal(streamed.result.reasoning, '第一段摘要\n\n第二段摘要');
  assert.equal(streamed.result.content, '好的');
  const completed = parse('responses', [
    {
      type: 'response.completed',
      response: {
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: '只在完成事件里' }], encrypted_content: 'x' },
          { type: 'message', content: [{ type: 'output_text', text: '完成' }] },
        ],
        usage: {},
      },
    },
  ]);
  assert.equal(completed.result.reasoning, '只在完成事件里');
  const opaque = parse('responses', [
    {
      type: 'response.completed',
      response: { output: [{ type: 'reasoning', summary: [], encrypted_content: 'x' }], usage: {} },
    },
  ]);
  assert.equal(opaque.result.reasoning, undefined);
});

test('chat reasoning fields, Gemini thoughts and tagged content all yield one reasoning text', () => {
  const chat = parse('chat', [
    { choices: [{ delta: { reasoning_content: '想一下', reasoning: '想一下' } }] },
    { choices: [{ delta: { reasoning_content: '，再想一下' } }] },
    { choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }] },
  ]);
  assert.equal(chat.result.reasoning, '想一下，再想一下');
  const details = parse('chat', [
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: '细节推理' }] } }] },
    { choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }] },
  ]);
  assert.equal(details.result.reasoning, '细节推理');
  const gemini = parse('gemini', [
    { candidates: [{ content: { parts: [{ text: '思考摘要', thought: true }, { text: '回答' }] } }] },
    { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
  ]);
  assert.equal(gemini.result.reasoning, '思考摘要');
  assert.equal(gemini.result.content, '回答');
  const tagged = parse('chat', [
    { choices: [{ delta: { content: '\x3cth' } }] },
    { choices: [{ delta: { content: 'ink>内联推理' } }] },
    { choices: [{ delta: { content: CLOSE + '正文' }, finish_reason: 'stop' }] },
  ]);
  assert.equal(tagged.result.reasoning, '内联推理');
  assert.equal(tagged.updates.at(-1), '内联推理');
  const plain = parse('chat', [
    { choices: [{ delta: { content: '普通回答 ' + OPEN + '不算' }, finish_reason: 'stop' }] },
  ]);
  assert.equal(plain.result.reasoning, undefined);
  assert.equal(taggedReasoning(OPEN + '未闭合'), '未闭合');
});

test('requests ask for readable reasoning only where it can be returned', () => {
  const responses = (reasoningEffort?: string) =>
    (protocolRequest({ ...cfg, protocol: 'responses', reasoningEffort }, [], [], 1024, '', () => '').body as any)
      .reasoning;
  assert.deepEqual(responses('high'), { effort: 'high', summary: 'auto' });
  assert.deepEqual(responses('none'), { effort: 'none' });
  assert.equal(responses(), undefined);
  const gemini = (thinkingBudget?: number) =>
    (protocolRequest({ ...cfg, protocol: 'gemini', thinkingBudget }, [], [], 1024, '', () => '').body as any)
      .generationConfig.thinkingConfig;
  assert.deepEqual(gemini(2048), { thinkingBudget: 2048, includeThoughts: true });
  assert.deepEqual(gemini(0), { thinkingBudget: 0 });
  assert.equal(gemini(), undefined);
});

test('reasoning time runs until readable text starts and a retry clears the partial reasoning', async (t) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: object, finish?: string) =>
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] }) + '\n\n',
      );
    send({ reasoning_content: '推理中' });
    if (requests === 1) {
      // Let the reasoning frame reach the client before the connection drops mid-response.
      await new Promise((done) => setTimeout(done, 60));
      res.destroy();
      return;
    }
    await new Promise((done) => setTimeout(done, 60));
    send({ content: '答案' }, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const model = new ModelClient(
    () => ({ ...cfg, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` }),
    () => '',
  );
  t.after(() => model.dispose());
  const updates: { text: string; durationMs?: number }[] = [];
  let resets = 0;
  const result = await model.complete([], [], new AbortController().signal, undefined, {
    onReasoning: (update) => updates.push(update),
    onReset: () => resets++,
    retries: 1,
  });
  assert.equal(requests, 2);
  assert.equal(resets, 1);
  assert.equal(result.content, '答案');
  assert.equal(result.reasoning, '推理中');
  assert.ok(result.reasoningMs! >= 50, `reasoningMs ${result.reasoningMs}`);
  assert.equal(updates.at(-1)!.durationMs, result.reasoningMs);
  assert.ok(updates.every((update) => update.text === '推理中'));
});

test('stream previews carry a bounded reasoning tail and keep it once reply text arrives', (t) => {
  const streams = new ReplyStreams(() => {}, 0);
  t.after(() => streams.dispose());
  const preview = streams.begin({ id: 'm', botId: 'a', runId: 'r', time: new Date().toISOString(), main: true });
  const startedAt = new Date().toISOString();
  preview.reason({ text: '甲'.repeat(3000) + '尾', startedAt });
  const live = streams.snapshot()[0];
  assert.equal(live.content, '');
  assert.equal(Array.from(live.reasoning!.text).length, 1200);
  assert.ok(live.reasoning!.text.endsWith('尾'));
  preview.reason({ text: '完整推理', startedAt, durationMs: 4200 });
  preview.update('正文');
  assert.deepEqual(streams.snapshot()[0].reasoning, { text: '完整推理', startedAt, durationMs: 4200 });
  assert.equal(streams.snapshot()[0].content, '正文');
});

test('appearance keeps a valid reasoning display choice', () => {
  assert.equal(DEFAULT_APPEARANCE.reasoning, 'collapsed');
  assert.equal(normalizeAppearance({ reasoning: 'hidden' }).reasoning, 'hidden');
  assert.equal(normalizeAppearance({ reasoning: 'loud' }).reasoning, 'collapsed');
});

test('a Bot conversation saves each reply reasoning beside the message but never in model history', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-reasoning-')),
    store = new Store(dir);
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;
  const long = '想'.repeat(25000);
  let seenLive = false;
  const complete: ModelClient['complete'] = async (_messages, _tools, _signal, onText, options) => {
    options?.onReasoning?.({ text: long, startedAt: new Date().toISOString() });
    seenLive = harness.streams.snapshot().some((reply) => reply.reasoning?.text.endsWith('想'));
    options?.onReasoning?.({ text: long, startedAt: new Date().toISOString(), durationMs: 3000 });
    onText?.('完成了');
    return { content: '完成了', calls: [], finishReason: 'stop', reasoning: long, reasoningMs: 3000 } as Completion;
  };
  const harness = new Harness(store, {} as VmController, { complete } as ModelClient, () => {}),
    bot = store.data.bots[0];
  t.after(async () => {
    harness.cancel(bot.id);
    await until(() => !harness.busy);
    harness.streams.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  await harness.run(bot.id, '分析一下');
  assert.ok(seenLive);
  const answer = store.data.messages.find((message) => message.presentation === 'answer')!;
  assert.equal(answer.content, '完成了');
  assert.equal(answer.reasoning!.durationMs, 3000);
  assert.equal(Array.from(answer.reasoning!.text).length, 20001);
  assert.ok(!JSON.stringify(store.data.conversations[bot.id]).includes('想想想'));
});
