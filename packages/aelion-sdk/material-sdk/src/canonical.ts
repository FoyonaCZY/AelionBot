import type { JsonValue } from '@aelionsdk/core';

function serialize(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const item = value[key];
      if (item === undefined) throw new TypeError('Canonical JSON cannot contain undefined');
      return `${JSON.stringify(key)}:${serialize(item)}`;
    })
    .join(',')}}`;
}

/** Deterministic JSON serialization used for AMP file and manifest integrity. */
export function canonicalizeMaterialJson(value: JsonValue): string {
  return serialize(value);
}

export function canonicalMaterialBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalizeMaterialJson(value));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const source = new Uint8Array(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
