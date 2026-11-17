import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answer, inTempDir, tempDir } from './helpers';
import { Spending, type SpendingAlert } from '../electron/core/app/spending';
import { usageReport } from '../electron/core/app/usage-report';
import { serializePriceTable } from '../electron/core/model/model-price-source';
import { TaskScheduler } from '../electron/core/scheduler/task-scheduler';
import { Harness } from '../electron/core/agent/harness';
import { Store } from '../electron/core/storage/store';
import { formatMoney, type PriceTable, type StoredSpending } from '../shared/model-pricing';
import type { UsageRecord } from '../shared/types/runtime-types';
import type { ModelSelection } from '../shared/types/core';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import { AppError } from '../shared/errors';

const table: PriceTable = {
  source: 'test',
  generatedAt: '2026-01-01',
  endpoints: [['api.maker.test', '/v1', 'maker']],
  services: { maker: { 'big-1': [2, 10, 0.2], 'small-1': [1, 1] } },
  reference: { 'big-1': [2, 10, 0.2] },
};
/** A dollar amount as the default interface language writes it. */
const usd = (value: number) => formatMoney(value, 'USD', 'zh-CN', 2);
const local = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();

function fixture(options: { now?: number; dataDir?: string; ownTable?: boolean } = {}) {
  const data: {
    spending?: StoredSpending;
    modelUsage: UsageRecord[];
    defaultModel?: ModelSelection;
    bots: Array<{ model?: ModelSelection }>;
  } = { modelUsage: [], bots: [] };
  const state = { now: options.now ?? local(2026, 11, 17), saves: 0, changes: 0, alerts: [] as SpendingAlert[] };
  const providers: Record<string, { baseUrl: string; name: string }> = {
    p1: { baseUrl: 'https://api.maker.test/v1', name: 'Maker' },
    p2: { baseUrl: 'https://proxy.example.test/v1', name: 'Proxy' },
  };
  const open = () =>
    new Spending({
      store: { data, save: () => void state.saves++ },
      provider: (id) => providers[id],
      changed: () => void state.changes++,
      onAlert: (alert) => void state.alerts.push(alert),
      now: () => state.now,
      dataDir: options.dataDir,
      ...(options.ownTable ? {} : { table }),
    });
  let sequence = 0;
  /** A request of `millions` million input tokens of small-1 (one unit of currency per million), made now. */
  const request = (millions: number, patch: Partial<UsageRecord> = {}): UsageRecord => ({
    id: `r${++sequence}`,
    purpose: 'foreground',
    model: 'small-1',
    providerId: 'p1',
    time: new Date(state.now).toISOString(),
    usage: { version: 2, inputTokens: Math.round(millions * 1_000_000), outputTokens: 0 },
    ...patch,
  });
  return { data, state, providers, open, request };
}
/** Adds a request to the records, then tells the spending service, as the app does. */
function spend(f: ReturnType<typeof fixture>, spending: Spending, millions: number, patch?: Partial<UsageRecord>) {
  const record = f.request(millions, patch);
  f.data.modelUsage.push(record);
  spending.record(record);
  return record;
}

test("costs follow the price table, the currency's rate and the user's own prices", () => {
  const f = fixture(),
    spending = f.open();
  const big = { providerId: 'p1', model: 'big-1', usage: { inputTokens: 1_000_000, outputTokens: 100_000 } };
  assert.deepEqual(spending.cost(big), { priced: true, cost: 3 });
  // The same model behind an address the table does not know is charged its reference price.
  assert.equal(spending.cost({ ...big, providerId: 'p2' }).cost, 3);
  assert.deepEqual(spending.cost({ ...big, model: 'unknown-9' }), { priced: false });
  assert.deepEqual(spending.cost({ ...big, usage: undefined }), { priced: true, cost: undefined });

  spending.save({ currency: 'CNY', rate: 7 });
  assert.equal(spending.cost(big).cost, 21);
  assert.deepEqual(spending.priceOf('p1', 'big-1'), {
    price: { input: 14, output: 70, cacheRead: 1.4 },
    custom: false,
  });

  // The user's price is in the chosen currency and replaces the table's for that provider only.
  spending.setPrice({ providerId: 'p1', model: 'big-1', price: { input: 1, output: 2 } });
  assert.equal(spending.cost(big).cost, 1.2);
  assert.equal(spending.priceOf('p1', 'big-1')?.custom, true);
  assert.equal(spending.cost({ ...big, providerId: 'p2' }).cost, 21);
  spending.setPrice({ providerId: 'p1', model: 'unknown-9', price: { input: 0, output: 0 } });
  assert.deepEqual(spending.cost({ ...big, model: 'unknown-9' }), { priced: true, cost: 0 });
  spending.setPrice({ providerId: 'p1', model: 'big-1', price: null });
  assert.equal(spending.cost(big).cost, 21);

  for (const input of [
    { providerId: '', model: 'big-1', price: { input: 1, output: 1 } },
    { providerId: 'p1', model: ' ', price: { input: 1, output: 1 } },
  ])
    assert.throws(
      () => spending.setPrice(input),
      (error: AppError) => error.code === 'spending.input_invalid',
    );
  for (const price of [{ input: -1, output: 1 }, { input: 1 }, { input: 1, output: Number.NaN }])
    assert.throws(
      () => spending.setPrice({ providerId: 'p1', model: 'big-1', price }),
      (error: AppError) => error.code === 'spending.amount_invalid',
    );
  assert.throws(
    () => spending.save({ currency: 'XXX' }),
    (error: AppError) => error.code === 'spending.currency_invalid',
  );
  assert.throws(
    () => spending.save({ rate: 0 }),
    (error: AppError) => error.code === 'spending.amount_invalid',
  );
});

test('amounts the user typed follow a change of currency', () => {
  const f = fixture(),
    spending = f.open();
  spending.save({ monthlyBudget: 100, dailyBudget: 10 });
  spending.setPrice({ providerId: 'p1', model: 'big-1', price: { input: 2, output: 4, cacheRead: 0.5 } });
  spending.save({ currency: 'CNY', rate: 7 });
  let settings = spending.settings();
  assert.equal(settings.monthlyBudget, 700);
  assert.equal(settings.dailyBudget, 70);
  assert.deepEqual(settings.prices, [{ providerId: 'p1', model: 'big-1', input: 14, output: 28, cacheRead: 3.5 }]);
  // Changing only the rate leaves what was typed in that currency alone.
  spending.save({ rate: 7.2 });
  assert.equal(spending.settings().monthlyBudget, 700);
  spending.save({ currency: 'USD' });
  settings = spending.settings();
  assert.equal(settings.monthlyBudget, 97.22);
  assert.equal(settings.rates.CNY, 7.2);
  // An empty budget means no limit.
  spending.save({ monthlyBudget: null, dailyBudget: 0 });
  assert.equal(spending.settings().monthlyBudget, undefined);
  assert.equal(spending.settings().dailyBudget, undefined);
});

test('the month and the day count their own requests and start over when they end', () => {
  const f = fixture({ now: local(2026, 11, 17) });
  f.data.modelUsage.push(
    f.request(50, { time: new Date(local(2026, 10, 31, 23)).toISOString() }),
    f.request(3, { time: new Date(local(2026, 11, 1, 0)).toISOString() }),
    f.request(2, { time: new Date(local(2026, 11, 16)).toISOString() }),
    f.request(1, { time: new Date(local(2026, 11, 17, 1)).toISOString() }),
    f.request(9, { model: 'unknown-9' }),
    f.request(9, { usage: undefined }),
  );
  const spending = f.open();
  spending.save({ monthlyBudget: 20 });
  let view = spending.view();
  assert.deepEqual(view.month, { key: '2026-11', spent: 6, budget: 20, level: undefined });
  assert.deepEqual(view.day, { key: '2026-11-17', spent: 1 });
  spend(f, spending, 0.5);
  assert.equal(spending.view().month.spent, 6.5);
  assert.equal(spending.view().day.spent, 1.5);
  f.state.now = local(2026, 11, 18, 0);
  view = spending.view();
  assert.equal(view.month.spent, 6.5);
  assert.deepEqual(view.day, { key: '2026-11-18', spent: 0 });
  f.state.now = local(2026, 12, 1, 0);
  view = spending.view();
  assert.equal(view.month.key, '2026-12');
  assert.equal(view.month.spent, 0);
  // A request counted while the totals are being counted afresh is not counted twice.
  spend(f, spending, 2);
  assert.equal(spending.view().month.spent, 2);
});

test('each budget level is announced once per period, also across a restart', () => {
  const f = fixture({ now: local(2026, 11, 17) });
  let spending = f.open();
  spending.save({ monthlyBudget: 10 });
  spend(f, spending, 7);
  assert.equal(f.state.alerts.length, 0);
  spend(f, spending, 1.5);
  assert.deepEqual(f.state.alerts, [
    { period: 'month', level: 'warning', spent: 8.5, budget: 10, currency: 'USD', paused: false },
  ]);
  assert.equal(spending.alertText(f.state.alerts[0]), `本月花费已达预算的 80%：${usd(8.5)} / ${usd(10)}`);
  assert.equal(spending.view().alert?.id, 'month:2026-11:warning');
  spend(f, spending, 1);
  assert.equal(f.state.alerts.length, 1);
  spend(f, spending, 1);
  assert.equal(f.state.alerts.length, 2);
  assert.equal(f.state.alerts[1].level, 'exceeded');
  assert.equal(spending.view().month.level, 'exceeded');
  spend(f, spending, 1);
  assert.equal(f.state.alerts.length, 2);

  // After a restart the month is still over budget and nothing is announced again.
  spending = f.open();
  spend(f, spending, 1);
  assert.equal(f.state.alerts.length, 2);
  assert.equal(spending.view().alert?.id, 'month:2026-11:exceeded');

  // A raised budget starts over quietly, and its own levels are announced when they come.
  spending.save({ monthlyBudget: 20 });
  assert.equal(spending.view().month.level, undefined);
  assert.equal(f.state.alerts.length, 2);
  spend(f, spending, 4);
  assert.equal(f.state.alerts.length, 3);
  assert.equal(f.state.alerts[2].level, 'warning');
  // A budget the user lowers below what is spent tells them on the page, not with an announcement.
  spending.save({ monthlyBudget: 5 });
  assert.equal(spending.view().month.level, 'exceeded');
  spend(f, spending, 1);
  assert.equal(f.state.alerts.length, 3);

  // A new month announces again; one request may go straight past the whole budget.
  f.state.now = local(2026, 12, 2);
  spend(f, spending, 6);
  assert.equal(f.state.alerts.length, 4);
  assert.deepEqual(f.state.alerts[3], {
    period: 'month',
    level: 'exceeded',
    spent: 6,
    budget: 5,
    currency: 'USD',
    paused: false,
  });
  assert.equal(spending.alertText(f.state.alerts[3]), `本月花费已超出预算：${usd(6)} / ${usd(5)}`);

  // The day has its own budget and its own announcements; one that holds automatic runs says so.
  spending.save({ monthlyBudget: null, dailyBudget: 10, onExceeded: 'pause' });
  f.state.now = local(2026, 12, 3);
  spend(f, spending, 9);
  assert.deepEqual(f.state.alerts[4], {
    period: 'day',
    level: 'warning',
    spent: 9,
    budget: 10,
    currency: 'USD',
    paused: false,
  });
  spend(f, spending, 2);
  assert.equal(f.state.alerts[5].paused, true);
  assert.equal(spending.alertText(f.state.alerts[5]), `今日花费已超出预算，自动运行已暂停：${usd(11)} / ${usd(10)}`);
});

test('a used-up budget holds automatic runs only when asked to, until the period ends or the budget grows', () => {
  const f = fixture({ now: local(2026, 11, 17) }),
    spending = f.open();
  spending.save({ monthlyBudget: 10 });
  spend(f, spending, 11);
  assert.equal(spending.pausedReason(), undefined);
  assert.equal(spending.view().paused, false);
  spending.save({ onExceeded: 'pause' });
  assert.equal(spending.pausedReason(), '本月花费已超出预算，自动运行已暂停');
  assert.equal(spending.view().paused, true);
  spending.save({ monthlyBudget: 50 });
  assert.equal(spending.pausedReason(), undefined);
  spending.save({ dailyBudget: 5 });
  assert.equal(spending.pausedReason(), '今日花费已超出预算，自动运行已暂停');
  f.state.now = local(2026, 11, 18);
  assert.equal(spending.pausedReason(), undefined);
  spending.save({ monthlyBudget: 10, dailyBudget: null });
  assert.equal(spending.pausedReason(), '本月花费已超出预算，自动运行已暂停');
  f.state.now = local(2026, 12, 1);
  assert.equal(spending.pausedReason(), undefined);
  assert.equal(spending.view().paused, false);
});

test('the price list covers models that were used, are chosen or have a price of the user', () => {
  const f = fixture(),
    spending = f.open();
  f.data.defaultModel = { providerId: 'p2', model: 'big-1', contextTokens: 100000 };
  f.data.bots.push({ model: { providerId: 'p1', model: 'small-1', contextTokens: 100000 } });
  f.data.modelUsage.push(
    f.request(1, { model: 'unknown-9' }),
    f.request(1, { model: 'old-1', providerId: 'gone-1234567890', providerName: 'Gone' }),
    f.request(1, { model: 'first-1', providerId: undefined }),
  );
  spending.setPrice({ providerId: 'p1', model: 'big-1', price: { input: 5, output: 6 } });
  assert.deepEqual(spending.prices(), [
    { providerId: 'gone-1234567890', providerName: 'Gone', model: 'old-1', custom: false },
    {
      providerId: 'p1',
      providerName: 'Maker',
      model: 'big-1',
      price: { input: 5, output: 6 },
      builtin: { input: 2, output: 10, cacheRead: 0.2 },
      custom: true,
    },
    {
      providerId: 'p1',
      providerName: 'Maker',
      model: 'small-1',
      price: { input: 1, output: 1 },
      builtin: { input: 1, output: 1 },
      custom: false,
    },
    { providerId: 'p1', providerName: 'Maker', model: 'unknown-9', custom: false },
    {
      providerId: 'p2',
      providerName: 'Proxy',
      model: 'big-1',
      price: { input: 2, output: 10, cacheRead: 0.2 },
      builtin: { input: 2, output: 10, cacheRead: 0.2 },
      custom: false,
    },
    { providerId: 'legacy', providerName: '早期记录', model: 'first-1', custom: false },
  ]);
});

test('the usage report adds up costs and names what has no price', () => {
  const f = fixture({ now: local(2026, 11, 17) }),
    spending = f.open();
  f.data.modelUsage.push(
    f.request(2),
    f.request(1, {
      model: 'big-1',
      usage: { version: 2, inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 0 },
    }),
    f.request(3, { model: 'unknown-9' }),
    f.request(1, { usage: undefined, error: 'timeout' }),
  );
  const report = usageReport(
    f.data.modelUsage,
    [{ id: 'p1', name: 'Maker' }],
    { from: '2026-11-17', to: '2026-11-17', granularity: 'day' },
    {
      currency: spending.settings().currency,
      cost: (record) => spending.cost(record),
      priceOf: (providerId, model) => spending.priceOf(providerId, model),
    },
  );
  assert.equal(report.currency, 'USD');
  assert.equal(report.totals.cost, 2 + 1 + 0.1);
  assert.equal(report.totals.costRequests, 2);
  assert.equal(report.totals.unpricedRequests, 1);
  assert.equal(report.unpricedModels, 1);
  assert.equal(report.buckets[0].cost, 3.1);
  assert.equal(report.byProvider[0].cost, 3.1);
  const byModel = Object.fromEntries(report.byModel.map((group) => [group.model, group]));
  assert.deepEqual(byModel['small-1'].price, { input: 1, output: 1 });
  assert.equal(byModel['small-1'].cost, 2);
  assert.equal(byModel['small-1'].customPrice, false);
  assert.equal(byModel['unknown-9'].price, undefined);
  assert.equal(byModel['unknown-9'].unpricedRequests, 1);
  // Without prices the report still works and counts nothing as unpriced.
  const plain = usageReport(f.data.modelUsage, [], { from: '2026-11-17', to: '2026-11-17', granularity: 'day' });
  assert.equal(plain.totals.cost, 0);
  assert.equal(plain.unpricedModels, 0);
});

test('newer prices are fetched into the data folder; a failure keeps the table in use', async (t) => {
  const dataDir = tempDir(t),
    f = fixture({ now: local(2099, 1, 2), dataDir });
  const source = {
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `service-${index}`,
        { id: `service-${index}`, models: { m: { cost: { input: 1, output: 2 } } } },
      ]),
    ),
    openai: { id: 'openai', models: { 'gpt-x': { cost: { input: 1, output: 4 } } } },
    anthropic: { id: 'anthropic', models: { 'claude-x': { cost: { input: 3, output: 15 } } } },
    maker: { id: 'maker', api: 'https://api.maker.test/v1', models: { 'small-1': { cost: { input: 4, output: 4 } } } },
  };
  let response: Response = new Response('{}', { status: 503 }),
    asked = '';
  const spending = new Spending({
    store: { data: f.data, save: () => {} },
    provider: (id) => f.providers[id],
    changed: () => void f.state.changes++,
    now: () => f.state.now,
    dataDir,
    table,
    fetch: async (url) => {
      asked = url;
      return response;
    },
  });
  const small = { providerId: 'p1', model: 'small-1', usage: { inputTokens: 1_000_000, outputTokens: 0 } };
  await assert.rejects(spending.refreshPrices(), (error: AppError) => error.code === 'pricing.refresh_failed');
  assert.equal(asked, 'https://models.dev/api.json');
  assert.equal(spending.cost(small).cost, 1);
  assert.ok(!existsSync(join(dataDir, 'model-prices.json')));
  response = new Response(JSON.stringify({ unexpected: true }));
  await assert.rejects(spending.refreshPrices(), (error: AppError) => error.code === 'pricing.source_invalid');
  assert.equal(spending.cost(small).cost, 1);

  response = new Response(JSON.stringify(source));
  assert.deepEqual(await spending.refreshPrices(), { models: 23, generatedAt: '2099-01-02' });
  assert.equal(spending.cost(small).cost, 4);
  assert.equal(spending.view().priceTable.generatedAt, '2099-01-02');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'model-prices.json'), 'utf8')).generatedAt, '2099-01-02');

  // The next launch reads the refreshed copy, unless the bundled table is newer or the copy is damaged.
  const relaunched = fixture({ dataDir, ownTable: true }).open();
  assert.equal(relaunched.view().priceTable.generatedAt, '2099-01-02');
  writeFileSync(join(dataDir, 'model-prices.json'), serializePriceTable({ ...table, generatedAt: '2000-01-01' }));
  assert.notEqual(fixture({ dataDir, ownTable: true }).open().view().priceTable.generatedAt, '2000-01-01');
  writeFileSync(join(dataDir, 'model-prices.json'), '{ not json');
  assert.ok(fixture({ dataDir, ownTable: true }).open().view().priceTable.models > 1000);
});

test('an automation that is due waits while automatic runs are held, and running it by hand still works', (t) => {
  const store = inTempDir(t, (dir) => new Store(dir)),
    bot = store.data.bots[0],
    sent: string[] = [];
  let clock = Date.parse('2026-09-06T00:00:00Z'),
    held: string | undefined = '本月花费已超出预算，自动运行已暂停';
  const scheduler = new TaskScheduler(
    store,
    {
      ready: () => true,
      send: (target, prompt, scheduled) => {
        sent.push(prompt);
        store.message(target.id, 'user', prompt, { scheduled, inputState: 'queued' });
      },
    },
    () => {},
    () => clock,
    { held: () => held },
  );
  t.after(() => scheduler.dispose());
  const task = scheduler.create({
    target: { kind: 'bot', id: bot.id },
    title: '每日核对',
    prompt: '核对待办并汇报',
    schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
  });
  const saved = () => store.data.scheduledTasks.find((item) => item.id === task.id)!;
  // Not due yet: nothing to hold, nothing to show.
  scheduler.tick();
  assert.equal(saved().error, undefined);
  clock = Date.parse('2026-09-06T01:00:01Z');
  scheduler.tick();
  assert.deepEqual(sent, []);
  assert.equal(saved().error, '本月花费已超出预算，自动运行已暂停');
  assert.equal(saved().status, 'enabled');
  assert.equal(saved().lastRun, undefined);
  assert.equal(saved().nextRunAt, '2026-09-06T01:00:00.000Z');
  // The user may still run it themselves.
  scheduler.runNow(task.id);
  assert.deepEqual(sent, ['核对待办并汇报']);
  assert.equal(saved().error, undefined);

  // A second automation that waited starts as soon as runs are allowed again.
  const other = scheduler.create({
    target: { kind: 'bot', id: store.createBot('Other', 'test').id },
    title: '盘点',
    prompt: '盘点库存',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
  });
  const waiting = () => store.data.scheduledTasks.find((item) => item.id === other.id)!;
  clock += 31 * 60000;
  scheduler.tick();
  assert.equal(waiting().error, '本月花费已超出预算，自动运行已暂停');
  assert.equal(sent.length, 1);
  held = undefined;
  scheduler.tick();
  assert.deepEqual(sent, ['核对待办并汇报', '盘点库存']);
  assert.equal(waiting().error, undefined);
});

test('a goal stops keeping itself going while automatic runs are held', async (t) => {
  const store = inTempDir(t, (dir) => new Store(dir)),
    bot = store.data.bots[0];
  store.data.model.model = 'test';
  let turns = 0;
  const model = {
    complete: async () => {
      turns++;
      return answer('我会继续处理。');
    },
  } as unknown as ModelClient;
  const harness = new Harness(store, {} as unknown as VmController, model, () => {});
  t.after(() => harness.disposeTools());
  harness.setAutomaticRunsPaused(() => '本月花费已超出预算，自动运行已暂停');
  await harness.run(bot.id, '/goal 修复项目并验证');
  // Without the hold the same answer is sent back twice more before the run gives up.
  assert.equal(turns, 1);
  const item = store.data.workItems![0];
  assert.equal(item.status, 'blocked');
  assert.equal(item.reason, '本月花费已超出预算，自动运行已暂停');
  assert.equal(store.data.runs[0].status, 'completed');
  assert.ok(
    store.data.messages.some((message) => message.role === 'assistant' && message.content === '我会继续处理。'),
  );
});
