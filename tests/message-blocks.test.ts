import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  calculate,
  createMessageBlock,
  evaluateFormula,
  messageBlockSegments,
  stripBlockMarkers,
  stripBlockPlacements,
  type CalculatorSpec,
} from '../shared/chat/message-blocks';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';

const stamp = '2026-01-01T00:00:00.000Z';
const make = (input: Record<string, unknown>) => createMessageBlock(input, randomUUID(), stamp);

const chart = {
  type: 'chart',
  title: '季度营收',
  spec: {
    chartType: 'bar',
    categories: ['Q1', 'Q2'],
    series: [{ name: '营收', values: [1240, 1480] }],
    unit: '万元',
  },
  fallback: 'Q1 营收 1,240 万元，Q2 1,480 万元',
};

const tax: CalculatorSpec = {
  inputs: [
    { id: 'gross', label: '税前月薪', type: 'money', value: 30000, unit: '元' },
    { id: 'social', label: '社保公积金', type: 'percent', value: 22 },
    { id: 'special', label: '专项附加扣除', type: 'money', value: 2000, unit: '元' },
  ],
  taxableFormula: 'gross*(1-social/100)-special-5000',
  brackets: [
    { upTo: 3000, rate: 0.03 },
    { upTo: 12000, rate: 0.1, quickDeduction: 210 },
    { upTo: 25000, rate: 0.2, quickDeduction: 1410 },
    { upTo: null, rate: 0.3, quickDeduction: 4410 },
  ],
  outputs: [
    { label: '税后到手', formula: 'gross-gross*social/100-result', unit: '元' },
    { label: '应纳税所得额', formula: 'taxable', unit: '元' },
    { label: '个人所得税', formula: 'result', unit: '元' },
  ],
};

test('a chart block keeps its data and fallback', () => {
  const block = make(chart);
  assert.equal(block.type, 'chart');
  assert.equal(block.version, 1);
  assert.equal(block.fallback, chart.fallback);
  if (block.type === 'chart') assert.deepEqual(block.spec.series[0].values, [1240, 1480]);
});

test('chart series must match categories and stay within limits', () => {
  assert.throws(
    () =>
      make({
        ...chart,
        spec: { ...chart.spec, series: [{ name: '营收', values: [1240] }] },
      }),
    { code: 'block.invalid' },
  );
  assert.throws(
    () =>
      make({
        ...chart,
        spec: {
          ...chart.spec,
          categories: Array.from({ length: 61 }, (_, i) => `C${i}`),
          series: [{ name: 'x', values: Array(61).fill(1) }],
        },
      }),
    { code: 'block.invalid' },
  );
});

test('fallback is required and bounded', () => {
  assert.throws(() => make({ ...chart, fallback: '' }), { code: 'block.invalid' });
  assert.throws(() => make({ ...chart, fallback: 'x'.repeat(601) }), { code: 'block.invalid' });
});

test('tables enforce column and row limits', () => {
  const table = {
    type: 'table',
    spec: { columns: [{ label: '渠道' }, { label: '转化率', format: 'percent' }], rows: [['搜索', 0.12]] },
    fallback: '搜索渠道转化率 12%',
  };
  assert.equal(make(table).type, 'table');
  assert.throws(() => make({ ...table, spec: { columns: [], rows: [] } }), { code: 'block.invalid' });
  assert.throws(
    () => make({ ...table, spec: { ...table.spec, rows: Array.from({ length: 201 }, () => ['x', 0.1]) } }),
    { code: 'block.invalid' },
  );
});

test('a tax calculator computes the bracket, tax and net pay', () => {
  const block = make({
    type: 'calculator',
    title: '税后收入估算',
    spec: tax,
    fallback: '税前 30,000 元，税后 21,530 元',
  });
  assert.equal(block.type, 'calculator');
  const result = calculate(tax);
  assert.equal(result.values.gross, 30000);
  assert.equal(result.primary, 1870);
  assert.equal(result.outputs[0].value, 21530);
  assert.equal(result.outputs[1].value, 16400);
});

test('formulas reject unknown names and prototype keys', () => {
  assert.equal(evaluateFormula('min(2, 3) * 4', {}), 8);
  assert.throws(() => evaluateFormula('unknown + 1', {}), { code: 'block.invalid' });
  assert.throws(() => evaluateFormula('constructor', {}), { code: 'block.invalid' });
  assert.throws(() => evaluateFormula('__proto__', {}), { code: 'block.invalid' });
  assert.throws(() => evaluateFormula('1 / 0', {}), { code: 'block.invalid' });
});

test('a calculator with an invalid formula is rejected before display', () => {
  assert.throws(
    () =>
      make({
        type: 'calculator',
        spec: { ...tax, outputs: [{ label: '结果', formula: 'nope' }] },
        fallback: '测试',
      }),
    { code: 'block.invalid' },
  );
});

test('markers interleave blocks between paragraphs and unused blocks follow the text', () => {
  const first = make(chart),
    second = make({
      type: 'metrics',
      spec: { items: [{ label: '全年营收', value: '6,860 万' }] },
      fallback: '全年营收 6,860 万元',
    });
  const segments = messageBlockSegments(`第一段\n[[block:${first.id}]]\n第二段\n[[block:${second.id}]]`, [
    first,
    second,
  ]);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ['text', 'block', 'text', 'block'],
  );
  const trailing = messageBlockSegments('只有文字', [first]);
  assert.deepEqual(
    trailing.map((segment) => segment.kind),
    ['text', 'block'],
  );
  const unknown = messageBlockSegments(`文字[[block:missing]]`, [first]);
  assert.deepEqual(
    unknown.map((segment) => segment.kind),
    ['text', 'block'],
  );
  assert.equal(stripBlockMarkers(`文字[[block:${first.id}]]`), '文字');
});

test('a marker the model named itself anchors the next stored block', () => {
  const block = make(chart),
    segments = messageBlockSegments('结论[[block:rates]]之后的段落', [block]);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ['text', 'block', 'text'],
  );
  assert.equal(segments[0].kind === 'text' ? segments[0].text : '', '结论');
  assert.equal(segments[2].kind === 'text' ? segments[2].text : '', '之后的段落');
});

test('a placement marker without any stored block never reaches the reader', () => {
  const segments = messageBlockSegments('正文\n\n[[block:rates]]\n\n后面', []);
  assert.deepEqual(segments, [{ kind: 'text', text: '正文\n\n后面' }]);
  assert.equal(stripBlockPlacements('正文\n[[block:rates]]\n后面'), '正文\n\n后面');
  assert.equal(stripBlockPlacements('正文里的 [[block:rates]] 只是文字'), '正文里的 [[block:rates]] 只是文字');
});

test('the message_block tool stores one block on the run for the final answer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-blocks-')),
    store = new Store(dir),
    bot = store.data.bots[0];
  store.data.model.model = 'fixture';
  let calls = 0;
  const model = {
    complete: async (messages: Array<{ role: string; content?: string }>) => {
      calls++;
      if (calls === 1)
        return {
          content: '先放一个指标块。',
          calls: [
            {
              id: randomUUID(),
              type: 'function' as const,
              function: {
                name: 'message_block',
                arguments: JSON.stringify({
                  type: 'metrics',
                  title: '全年关键指标',
                  spec: { items: [{ label: '全年营收', value: '6,860 万', delta: '+18.2%', tone: 'up' }] },
                  fallback: '全年营收 6,860 万元，同比 +18.2%',
                }),
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      const toolMessage = messages.find((message) => message.role === 'tool');
      const id = JSON.parse(toolMessage!.content || '{}').id;
      return { content: `结论：全年营收 6,860 万元。\n[[block:${id}]]`, calls: [], finishReason: 'stop' };
    },
  } as unknown as ModelClient;
  const harness = new Harness(store, {} as VmController, model, () => {});
  t.after(async () => {
    harness.streams.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  await harness.run(bot.id, '看一下全年营收');
  const run = store.data.runs[0];
  assert.equal(calls, 2);
  assert.equal(run.blocks?.length, 1);
  assert.equal(run.blocks?.[0].type, 'metrics');
  assert.match(
    store.data.messages.find((message) => message.role === 'assistant' && message.content.includes('[[block:'))!
      .content,
    /\[\[block:[A-Za-z0-9_-]+\]\]/,
  );
});
