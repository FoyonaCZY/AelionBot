import type { JsonValue } from '@aelionsdk/core';

import type { MaterialGraph } from './types.js';

export function identifier(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/gu, '_');
}

export function literal(value: JsonValue, backend: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${backend} material expressions only support finite numeric literals`);
  }
  return Number.isInteger(value) ? `${value.toString()}.0` : value.toString();
}

export function graphHash(graph: MaterialGraph): string {
  const serialized = JSON.stringify(graph);
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
