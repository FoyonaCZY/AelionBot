// Refreshes the bundled model price table (assets/model-prices.json) from models.dev's open data.
//
//   node --import tsx scripts/update-model-prices.ts            fetches the data
//   node --import tsx scripts/update-model-prices.ts data.json  converts a copy downloaded earlier
//
// The request carries nothing about this project. Review the diff before committing: each line is one model's
// price in US dollars per million tokens (input, output, cache read, cache write, then tiers by input length).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRICE_SOURCE_URL,
  parsePriceTable,
  priceTableFrom,
  priceTableModels,
  serializePriceTable,
} from '../electron/core/model/model-price-source';

const target = resolve(import.meta.dirname, '..', 'assets', 'model-prices.json');

async function main() {
  const local = process.argv[2];
  let data: unknown;
  if (local) data = JSON.parse(readFileSync(resolve(local), 'utf8'));
  else {
    const response = await fetch(PRICE_SOURCE_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${PRICE_SOURCE_URL} answered ${response.status}`);
    data = await response.json();
  }
  const today = new Date(),
    generatedAt = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const text = serializePriceTable(priceTableFrom(data, generatedAt));
  // What the app will load must pass the same check a refreshed table does.
  const table = parsePriceTable(JSON.parse(text));
  writeFileSync(target, text);
  console.log(
    `${target}: ${Object.keys(table.services).length} services, ${priceTableModels(table)} models, ` +
      `${Object.keys(table.reference).length} reference prices, ${table.endpoints.length} addresses, ` +
      `${(text.length / 1024).toFixed(0)} KB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
