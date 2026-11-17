import test from 'node:test';
import assert from 'node:assert/strict';
import bundled from '../assets/model-prices.json';
import {
  budgetLevel,
  budgetPeriods,
  builtinPrice,
  endpointService,
  usageCost,
  type PriceTable,
} from '../shared/model-pricing';
import {
  parsePriceTable,
  priceTableFrom,
  priceTableModels,
  serializePriceTable,
} from '../electron/core/model/model-price-source';
import { AppError } from '../shared/errors';

const table: PriceTable = {
  source: 'test',
  generatedAt: '2026-01-01',
  endpoints: [
    ['api.maker.test', '/v1', 'maker'],
    ['api.router.test', '/api/v1', 'router'],
    ['api.shared.test', '/paid/v1', 'shared'],
    ['api.shared.test', '/plan/v1', 'shared-plan'],
  ],
  services: {
    maker: {
      'big-1': [2, 10, 0.2, 2.5, [[200000, 4, 15, 0.4, 5]]],
      'Small-1': [0.5, 1.5],
      'big-1-2025-01-01': [3, 12],
    },
    router: { 'maker/big-1': [2.2, 11], 'maker/big-1:free': [0, 0] },
    shared: { 'big-1': [2, 10] },
    'shared-plan': { 'big-1': [0, 0] },
  },
  reference: { 'big-1': [2, 10, 0.2, 2.5], 'small-1': [0.5, 1.5], 'other/open-9': [0.3, 0.9] },
};

test('an API address finds its service by host, then by the longest matching path', () => {
  assert.equal(endpointService(table, 'https://api.maker.test/v1'), 'maker');
  assert.equal(endpointService(table, 'https://API.Maker.test/v1/'), 'maker');
  assert.equal(endpointService(table, 'api.maker.test'), 'maker');
  assert.equal(endpointService(table, 'https://api.shared.test/plan/v1'), 'shared-plan');
  assert.equal(endpointService(table, 'https://api.shared.test/paid/v1/chat'), 'shared');
  // A path the table does not list falls back to the host's first entry.
  assert.equal(endpointService(table, 'https://api.shared.test/other'), 'shared');
  assert.equal(endpointService(table, 'https://proxy.example.test/v1'), undefined);
  assert.equal(endpointService(table, 'not a url at all ::'), undefined);
  assert.equal(endpointService(table, undefined), undefined);
});

test('a model is priced by its service, else only by an exact reference ID', () => {
  const known = builtinPrice(table, 'https://api.maker.test/v1', 'big-1');
  assert.equal(known?.basis, 'service');
  assert.equal(known?.service, 'maker');
  assert.deepEqual(known?.price, {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [{ above: 200000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
  });
  // Case does not matter, and the Gemini style `models/` prefix is the same model.
  assert.equal(builtinPrice(table, 'https://api.maker.test/v1', 'small-1')?.price.input, 0.5);
  assert.equal(builtinPrice(table, 'https://api.maker.test/v1', 'models/big-1')?.price.input, 2);
  // The router's own listing wins at the router's address, including its free variant.
  assert.equal(builtinPrice(table, 'https://api.router.test/api/v1', 'maker/big-1')?.price.input, 2.2);
  assert.equal(builtinPrice(table, 'https://api.router.test/api/v1', 'maker/big-1:free')?.price.output, 0);
  // An unknown address: the list price by the bare ID, or by the whole `vendor/model` name.
  const proxied = builtinPrice(table, 'https://proxy.example.test/v1', 'anything/big-1');
  assert.equal(proxied?.basis, 'reference');
  assert.equal(proxied?.price.input, 2);
  assert.equal(builtinPrice(table, undefined, 'Big-1')?.price.output, 10);
  assert.equal(builtinPrice(table, 'https://proxy.example.test/v1', 'other/open-9')?.price.input, 0.3);
  // Nothing is guessed: a dated ID, a variant suffix or a different name has no price.
  assert.equal(builtinPrice(table, 'https://proxy.example.test/v1', 'big-1-2025-06-01'), undefined);
  assert.equal(builtinPrice(table, 'https://proxy.example.test/v1', 'maker/big-1:free'), undefined);
  assert.equal(builtinPrice(table, 'https://proxy.example.test/v1', 'big-2'), undefined);
  assert.equal(builtinPrice(table, 'https://api.maker.test/v1', '  '), undefined);
});

test('cached input is taken out of the input and charged at its own price', () => {
  const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
  // 1M input of which 600k was read from the cache and 100k written to it, 100k output.
  const cost = usageCost(price, {
    inputTokens: 1_000_000,
    cachedTokens: 600_000,
    cacheWriteTokens: 100_000,
    outputTokens: 100_000,
  });
  assert.equal(Number(cost!.toFixed(6)), Number((0.3 * 2 + 0.6 * 0.2 + 0.1 * 2.5 + 0.1 * 10).toFixed(6)));
  // Without cache prices the cached parts cost what input costs.
  assert.equal(
    usageCost({ input: 2, output: 10 }, { inputTokens: 1_000_000, cachedTokens: 600_000, outputTokens: 0 }),
    2,
  );
  // Counts that cannot be right never make the input negative.
  assert.equal(
    usageCost(price, { inputTokens: 100, cachedTokens: 500, cacheWriteTokens: 500, outputTokens: 0 }),
    0.00002,
  );
  assert.equal(usageCost(price, { outputTokens: 1_000_000 }), 10);
  assert.equal(usageCost(price, {}), undefined);
  assert.equal(usageCost(price, undefined), undefined);
});

test('a request longer than a tier is charged at that tier', () => {
  const price = {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    tiers: [
      { above: 200_000, input: 4, output: 15, cacheRead: 0.4 },
      { above: 500_000, input: 8, output: 30 },
    ],
  };
  assert.equal(usageCost(price, { inputTokens: 200_000, outputTokens: 0 }), 0.4);
  assert.equal(usageCost(price, { inputTokens: 300_000, outputTokens: 100_000 }), 2.7);
  // The largest tier passed applies; it has no cache price, so cached input costs its input price.
  assert.equal(usageCost(price, { inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 0 }), 8);
});

test("models.dev's data becomes services, addresses and reference prices", () => {
  const data = {
    maker: {
      id: 'maker',
      models: {
        'big-1': {
          cost: {
            input: 2,
            output: 10,
            cache_read: 0.2,
            tiers: [{ input: 4, output: 15, cache_read: 0.4, tier: { type: 'context', size: 200000 } }],
          },
        },
        'voice-1': { type: 'speech', cost: { input: 1, output: 1 } },
        'no-price': {},
        'guest-1': { cost: { input: 9, output: 9 }, canonical_model_id: 'other/guest-1' },
      },
    },
    router: {
      id: 'router',
      api: 'https://api.router.test/api/v1/',
      models: {
        'maker/big-1': { cost: { input: 2.2, output: 11 } },
        'maker/big-1:free': { cost: { input: 0, output: 0 } },
      },
    },
    'router-coding-plan': {
      id: 'router-coding-plan',
      api: 'https://api.router.test/api/v1',
      models: { 'maker/big-1': { cost: { input: 0, output: 0 } } },
    },
    templated: {
      id: 'templated',
      api: 'https://${ACCOUNT}.host.test/v1',
      models: { m: { cost: { input: 1, output: 1 } } },
    },
  };
  // The converter insists on the two services every real copy carries.
  assert.throws(
    () => priceTableFrom(data, '2026-01-01'),
    (error: AppError) => error.code === 'pricing.source_invalid',
  );
  assert.throws(
    () => priceTableFrom([], '2026-01-01'),
    (error: AppError) => error.code === 'pricing.source_invalid',
  );
  const filler = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `service-${index}`,
      { id: `service-${index}`, models: { m: { cost: { input: 1, output: 2 } } } },
    ]),
  );
  const converted = priceTableFrom(
    {
      ...filler,
      ...data,
      openai: { id: 'openai', models: { 'gpt-x': { cost: { input: 1, output: 4, cache_write: 1.25 } } } },
      anthropic: { id: 'anthropic', models: { 'claude-x': { cost: { input: 3, output: 15 } } } },
      openrouter: { id: 'openrouter', models: { 'vendor/open-1': { cost: { input: 0.1, output: 0.2 } } } },
    },
    '2026-01-01',
  );
  assert.deepEqual(converted.services.maker, {
    'big-1': [2, 10, 0.2, null, [[200000, 4, 15, 0.4]]],
    'guest-1': [9, 9],
  });
  assert.deepEqual(converted.services.openai['gpt-x'], [1, 4, null, 1.25]);
  // The pay-as-you-go service is its host's default; a templated address is left out.
  assert.deepEqual(
    converted.endpoints.filter(([host]) => host === 'api.router.test'),
    [
      ['api.router.test', '/api/v1', 'router'],
      ['api.router.test', '/api/v1', 'router-coding-plan'],
    ],
  );
  assert.ok(!converted.endpoints.some(([, , service]) => service === 'templated'));
  assert.equal(endpointService(converted, 'https://api.openai.com/v1'), 'openai');
  // Reference prices: makers' own bare IDs and the listing's vendor/model IDs, never a free offer.
  assert.deepEqual(converted.reference['gpt-x'], [1, 4, null, 1.25]);
  assert.deepEqual(converted.reference['vendor/open-1'], [0.1, 0.2]);
  assert.equal(converted.reference['big-1'], undefined);
  assert.equal(converted.reference['maker/big-1:free'], undefined);
  // What the app writes is what it reads back.
  const text = serializePriceTable(converted);
  assert.deepEqual(parsePriceTable(JSON.parse(text)), converted);
  assert.equal(priceTableModels(converted), 20 + 2 + 2 + 1 + 1 + 1 + 1 + 1);
});

test('a price table that is not one is refused', () => {
  const invalid = (value: unknown) =>
    assert.throws(
      () => parsePriceTable(value),
      (error: AppError) => error.code === 'pricing.table_invalid',
    );
  invalid(null);
  invalid({ ...table, generatedAt: 'yesterday' });
  invalid({ ...table, endpoints: [['host', '/v1']] });
  invalid({ ...table, services: { maker: { 'big-1': [2] } } });
  invalid({ ...table, services: { maker: { 'big-1': [2, -1] } } });
  invalid({ ...table, reference: { 'big-1': [2, 10, 'cheap'] } });
  invalid({ ...table, services: { maker: { 'big-1': [2, 10, null, null, [[200000, 4]]] } } });
  assert.equal(parsePriceTable(table), table);
});

test('the bundled price table loads and knows the common services', () => {
  const prices = parsePriceTable(bundled);
  assert.match(prices.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(priceTableModels(prices) > 1000);
  assert.equal(endpointService(prices, 'https://api.openai.com/v1'), 'openai');
  assert.equal(endpointService(prices, 'https://api.anthropic.com'), 'anthropic');
  assert.equal(endpointService(prices, 'https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(endpointService(prices, 'https://openrouter.ai/api/v1'), 'openrouter');
  // Every OpenAI model the table lists is priced at OpenAI's address, and by its bare ID behind a proxy.
  const [model] = Object.keys(prices.services.openai);
  assert.ok(builtinPrice(prices, 'https://api.openai.com/v1', model));
  assert.equal(builtinPrice(prices, 'https://proxy.example.test/v1', 'definitely-not-a-model'), undefined);
});

test('budget levels and periods', () => {
  assert.equal(budgetLevel(79.9, 100), undefined);
  assert.equal(budgetLevel(80, 100), 'warning');
  assert.equal(budgetLevel(100, 100), 'exceeded');
  assert.equal(budgetLevel(500, undefined), undefined);
  assert.equal(budgetLevel(500, 0), undefined);
  assert.deepEqual(budgetPeriods(new Date(2026, 10, 7, 23, 59)), { month: '2026-11', day: '2026-11-07' });
});
