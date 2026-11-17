// Builds the price table (shared/model-pricing.ts) from models.dev's open data: every service's list prices in US
// dollars per million tokens. scripts/update-model-prices.ts writes the bundled copy with it; the app uses it again
// when the user asks for newer prices.
import type { PriceTable, PriceTuple } from '../../../shared/model-pricing';
import { AppError } from '../../../shared/errors';

export const PRICE_SOURCE_URL = 'https://models.dev/api.json';

/** API addresses of services models.dev reaches through a vendor SDK and so lists without one. */
const EXTRA_ENDPOINTS: Record<string, string[]> = {
  openai: ['https://api.openai.com/v1'],
  anthropic: ['https://api.anthropic.com'],
  google: ['https://generativelanguage.googleapis.com'],
  xai: ['https://api.x.ai/v1'],
  mistral: ['https://api.mistral.ai/v1'],
  groq: ['https://api.groq.com/openai/v1'],
  cerebras: ['https://api.cerebras.ai/v1'],
  perplexity: ['https://api.perplexity.ai'],
  cohere: ['https://api.cohere.com', 'https://api.cohere.ai'],
  togetherai: ['https://api.together.xyz/v1', 'https://api.together.ai/v1'],
  deepinfra: ['https://api.deepinfra.com/v1/openai'],
  aihubmix: ['https://aihubmix.com/v1'],
  venice: ['https://api.venice.ai/api/v1'],
  vercel: ['https://ai-gateway.vercel.sh/v1'],
};
/**
 * Services that sell their own models: their lists give the reference price of a model served from an address the
 * table does not know. Earlier entries win when two list the same ID.
 */
const MAKERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'mistral',
  'moonshotai',
  'zhipuai',
  'alibaba',
  'minimax',
  'xiaomi',
  'cohere',
  'perplexity',
  'stepfun',
  'meta',
];
/** The service whose `vendor/model` IDs are the common way to name a model behind a gateway. */
const LISTING = 'openrouter';
/** A subscription plan shares its service's host; the pay-as-you-go service is the host's default. */
const PLAN = /(^|-)(coding|token|step)-plan(-|$)/;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const amount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function tuple(cost: Json | undefined): PriceTuple | undefined {
  const input = amount(cost?.input),
    output = amount(cost?.output);
  if (!cost || input === undefined || output === undefined) return;
  const read = amount(cost.cache_read),
    write = amount(cost.cache_write);
  const tiers: NonNullable<PriceTuple[4]> = [];
  for (const entry of Array.isArray(cost.tiers) ? cost.tiers : []) {
    const tier = object(entry),
      bound = object(tier?.tier),
      above = bound?.type === 'context' ? amount(bound.size) : undefined,
      tierInput = amount(tier?.input),
      tierOutput = amount(tier?.output);
    if (!tier || !above || tierInput === undefined || tierOutput === undefined) continue;
    const row: NonNullable<PriceTuple[4]>[number] = [above, tierInput, tierOutput];
    const tierRead = amount(tier.cache_read),
      tierWrite = amount(tier.cache_write);
    if (tierRead !== undefined || tierWrite !== undefined) row.push(tierRead ?? null);
    if (tierWrite !== undefined) row.push(tierWrite);
    tiers.push(row);
  }
  tiers.sort((a, b) => a[0] - b[0]);
  const result: PriceTuple = [input, output];
  if (read !== undefined || write !== undefined || tiers.length) result.push(read ?? null);
  if (write !== undefined || tiers.length) result.push(write ?? null);
  if (tiers.length) result.push(tiers);
  return result;
}

function endpoint(address: string): [string, string] | undefined {
  if (address.includes('${')) return;
  try {
    const url = new URL(address);
    return [url.host.toLowerCase(), url.pathname.replace(/\/+$/, '').toLowerCase()];
  } catch {
    return;
  }
}

/** The price table of models.dev's `api.json`. Throws when the data does not look like it. */
export function priceTableFrom(data: unknown, generatedAt: string): PriceTable {
  const providers = object(data);
  if (!providers) throw new AppError('pricing.source_invalid', '价格数据格式不对');
  const services: PriceTable['services'] = {},
    endpoints: PriceTable['endpoints'] = [],
    reference: PriceTable['reference'] = {},
    canonical = new Map<string, Map<string, string>>();
  for (const id of Object.keys(providers).sort()) {
    const provider = object(providers[id]),
      models = object(provider?.models);
    if (!provider || !models) continue;
    const list: Record<string, PriceTuple> = {},
      makers = new Map<string, string>();
    for (const modelId of Object.keys(models).sort()) {
      const model = object(models[modelId]);
      if (!model || (model.type !== undefined && model.type !== 'text' && model.type !== 'chat')) continue;
      const price = tuple(object(model.cost));
      if (!price) continue;
      list[modelId] = price;
      if (typeof model.canonical_model_id === 'string')
        makers.set(modelId, model.canonical_model_id.split('/')[0].toLowerCase());
    }
    if (!Object.keys(list).length) continue;
    services[id] = list;
    canonical.set(id, makers);
    for (const address of [
      ...(typeof provider.api === 'string' ? [provider.api] : []),
      ...(EXTRA_ENDPOINTS[id] || []),
    ]) {
      const place = endpoint(address);
      if (place) endpoints.push([place[0], place[1], id]);
    }
  }
  if (Object.keys(services).length < 20 || !services.openai || !services.anthropic)
    throw new AppError('pricing.source_invalid', '价格数据不完整');
  // A host's first entry is its default: the pay-as-you-go service before its plans, then the shortest path.
  endpoints.sort(
    (a, b) =>
      a[0].localeCompare(b[0]) ||
      Number(PLAN.test(a[2])) - Number(PLAN.test(b[2])) ||
      a[1].length - b[1].length ||
      a[2].localeCompare(b[2]),
  );
  const refer = (key: string, price: PriceTuple) => {
    // A free listing is that service's offer, not the model's list price.
    if (!price[0] && !price[1]) return;
    reference[key.toLowerCase()] ??= price;
  };
  for (const maker of MAKERS)
    for (const [modelId, price] of Object.entries(services[maker] || {})) {
      // A maker's list may also carry models of others it hosts.
      const owner = canonical.get(maker)?.get(modelId);
      if (!modelId.includes('/') && (!owner || owner === maker)) refer(modelId, price);
    }
  for (const [modelId, price] of Object.entries(services[LISTING] || {}))
    if (modelId.includes('/')) refer(modelId, price);
  return { source: PRICE_SOURCE_URL, generatedAt, endpoints, services, reference };
}

const isTuple = (value: unknown): value is PriceTuple =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.length <= 5 &&
  amount(value[0]) !== undefined &&
  amount(value[1]) !== undefined &&
  (value[2] === undefined || value[2] === null || amount(value[2]) !== undefined) &&
  (value[3] === undefined || value[3] === null || amount(value[3]) !== undefined) &&
  (value[4] === undefined ||
    (Array.isArray(value[4]) &&
      value[4].every(
        (tier) =>
          Array.isArray(tier) &&
          tier.length >= 3 &&
          tier.length <= 5 &&
          tier.every((part, index) => (index > 2 && part === null) || amount(part) !== undefined),
      )));

/** A price table read from a file, checked entry by entry. */
export function parsePriceTable(value: unknown): PriceTable {
  const table = object(value),
    services = object(table?.services),
    reference = object(table?.reference);
  const invalid = () => new AppError('pricing.table_invalid', '价格表格式不对');
  if (
    !table ||
    !services ||
    !reference ||
    typeof table.source !== 'string' ||
    typeof table.generatedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(table.generatedAt) ||
    !Array.isArray(table.endpoints)
  )
    throw invalid();
  for (const entry of table.endpoints)
    if (!Array.isArray(entry) || entry.length !== 3 || entry.some((part) => typeof part !== 'string')) throw invalid();
  for (const list of Object.values(services)) {
    const models = object(list);
    if (!models || !Object.values(models).every(isTuple)) throw invalid();
  }
  if (!Object.values(reference).every(isTuple)) throw invalid();
  return table as unknown as PriceTable;
}

export const priceTableModels = (table: PriceTable) =>
  Object.values(table.services).reduce((count, list) => count + Object.keys(list).length, 0);

/** The table as JSON with one model per line, so a change in the bundled copy reads as a price change. */
export function serializePriceTable(table: PriceTable) {
  const line = (key: string, value: unknown) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
    block = (list: Record<string, unknown>, indent: string) =>
      Object.keys(list)
        .map((key) => indent + line(key, list[key]))
        .join(',\n');
  return [
    '{',
    `  ${line('source', table.source)},`,
    `  ${line('generatedAt', table.generatedAt)},`,
    '  "endpoints": [',
    table.endpoints.map((entry) => '    ' + JSON.stringify(entry)).join(',\n'),
    '  ],',
    '  "services": {',
    Object.keys(table.services)
      .map((id) => `    ${JSON.stringify(id)}: {\n${block(table.services[id], '      ')}\n    }`)
      .join(',\n'),
    '  },',
    '  "reference": {',
    block(table.reference, '    '),
    '  }',
    '}',
    '',
  ].join('\n');
}
