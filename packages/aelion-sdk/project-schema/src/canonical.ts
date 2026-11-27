import type { JsonValue } from '@aelionsdk/core';

export class CanonicalizationError extends TypeError {
  public readonly code:
    | 'CANONICAL_UNSUPPORTED_VALUE'
    | 'CANONICAL_NON_FINITE_NUMBER'
    | 'CANONICAL_NEGATIVE_ZERO'
    | 'CANONICAL_UNSAFE_INTEGER';

  public constructor(code: CanonicalizationError['code'], message: string) {
    super(message);
    this.name = 'CanonicalizationError';
    this.code = code;
  }
}

/**
 * Orders two property keys by Unicode code point, without allocating.
 *
 * Materializing both keys as code-point arrays is the obvious way to write
 * this, and it is what a canonical serializer spends most of its time on: a
 * Project sorts the keys of every object it contains, so the comparator runs
 * hundreds of thousands of times per document and each call allocated two
 * arrays. Walking both keys in place stops at the first difference, which for
 * schema field names is almost always the first character.
 *
 * The two strings have to advance independently, because a leading surrogate
 * consumes two units when a trailing surrogate follows it and one when it does
 * not. Stepping both by the same amount would compare `U+DBFF U+1F900` against
 * `U+10FFFF` as if their first code points matched -- their first *unit* does.
 */
function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftLength = left.length;
  const rightLength = right.length;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLength && rightIndex < rightLength) {
    let leftPoint = left.charCodeAt(leftIndex);
    let leftWidth = 1;
    if (leftPoint >= 0xd800 && leftPoint <= 0xdbff && leftIndex + 1 < leftLength) {
      const trailing = left.charCodeAt(leftIndex + 1);
      if (trailing >= 0xdc00 && trailing <= 0xdfff) {
        leftPoint = (leftPoint - 0xd800) * 0x400 + (trailing - 0xdc00) + 0x10000;
        leftWidth = 2;
      }
    }
    let rightPoint = right.charCodeAt(rightIndex);
    let rightWidth = 1;
    if (rightPoint >= 0xd800 && rightPoint <= 0xdbff && rightIndex + 1 < rightLength) {
      const trailing = right.charCodeAt(rightIndex + 1);
      if (trailing >= 0xdc00 && trailing <= 0xdfff) {
        rightPoint = (rightPoint - 0xd800) * 0x400 + (trailing - 0xdc00) + 0x10000;
        rightWidth = 2;
      }
    }
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    leftIndex += leftWidth;
    rightIndex += rightWidth;
  }
  // One key ran out first, so it has the fewer code points. Only the sign is
  // read, and the units still unconsumed carry it.
  return leftLength - leftIndex - (rightLength - rightIndex);
}

function assertCanonicalNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError('CANONICAL_NON_FINITE_NUMBER', `Non-finite number at ${path}`);
  }
  if (Object.is(value, -0)) {
    throw new CanonicalizationError('CANONICAL_NEGATIVE_ZERO', `Negative zero at ${path}`);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new CanonicalizationError('CANONICAL_UNSAFE_INTEGER', `Unsafe integer at ${path}`);
  }
}

function isCanonicalNumber(value: number): boolean {
  return Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

/**
 * Sentinel for the fast walkers, which do not know where they are.
 *
 * Naming the offending value costs a string concatenation at every node, which
 * on a Project is the single most expensive thing the canonicalizer does — and
 * it is thrown away on every document that is actually valid. The fast walk
 * therefore reports only that something is wrong, and the exact code and path
 * are recovered by re-walking with {@link encode}, which happens once, on a
 * document that is about to be rejected anyway.
 *
 * One instance, created at load, so throwing it costs nothing.
 */
class CanonicalViolation extends Error {}

const VIOLATION = new CanonicalViolation('Value could not be canonicalized');

function rethrowWithPath(value: JsonValue, error: unknown): never {
  if (error !== VIOLATION) throw error;
  // Always throws: the slow walk applies the same rules that just failed.
  encode(value, '$');
  throw new CanonicalizationError('CANONICAL_UNSUPPORTED_VALUE', 'Value could not be canonicalized');
}

function encode(value: JsonValue, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assertCanonicalNumber(value, path);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => encode(entry, `${path}/${index}`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${encode(value[key] as JsonValue, `${path}/${key}`)}`)
      .join(',')}}`;
  }

  throw new CanonicalizationError('CANONICAL_UNSUPPORTED_VALUE', `Unsupported value at ${path}`);
}

/** Appends the canonical encoding of `value` to `out`, one fragment at a time. */
function write(value: JsonValue, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  const type = typeof value;
  if (type === 'string') {
    out.push(JSON.stringify(value));
    return;
  }
  if (type === 'number') {
    if (!isCanonicalNumber(value as number)) throw VIOLATION;
    out.push(JSON.stringify(value));
    return;
  }
  if (type === 'boolean') {
    out.push(value === true ? 'true' : 'false');
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(',');
      write(value[index] as JsonValue, out);
    }
    out.push(']');
    return;
  }
  if (type === 'object') {
    const source = value as Record<string, JsonValue>;
    const keys = Object.keys(source).sort(compareCodePoints);
    out.push('{');
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] ?? '';
      out.push(index > 0 ? `,${JSON.stringify(key)}:` : `${JSON.stringify(key)}:`);
      write(source[key] as JsonValue, out);
    }
    out.push('}');
    return;
  }
  throw VIOLATION;
}

export function canonicalStringify(value: JsonValue): string {
  const out: string[] = [];
  try {
    write(value, out);
  } catch (error) {
    rethrowWithPath(value, error);
  }
  return out.join('');
}

export async function canonicalHash(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/**
 * Copies `value` into fresh objects with canonically ordered keys.
 *
 * Serializing to a canonical string and parsing it back produces exactly this
 * result, and that is how it used to be written -- but it also builds a
 * multi-megabyte string for a document that is only ever read as objects. This
 * walks once instead.
 *
 * Keys are written with `defineProperty` whenever the key already resolves on
 * the fresh object, which is how `__proto__` and the rest of `Object.prototype`
 * become ordinary data properties here, exactly as `JSON.parse` would define
 * them. Plain assignment would mutate the prototype instead.
 */
function clone(value: JsonValue): JsonValue {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!isCanonicalNumber(value as number)) throw VIOLATION;
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const entry of value) result.push(clone(entry as JsonValue));
    return result;
  }
  if (type === 'object') {
    const source = value as Record<string, JsonValue>;
    const keys = Object.keys(source).sort(compareCodePoints);
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      const entry = clone(source[key] as JsonValue);
      if (key in result) {
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: entry,
        });
      } else {
        result[key] = entry;
      }
    }
    return result;
  }
  throw VIOLATION;
}

export function canonicalClone<T extends JsonValue>(value: T): T {
  try {
    return clone(value) as T;
  } catch (error) {
    rethrowWithPath(value, error);
  }
}

/**
 * Copies a JSON value, keeping the key order it already has.
 *
 * {@link canonicalClone} additionally sorts every object's keys and re-checks
 * every number, which is what you want at a trust boundary and pure waste
 * inside one: a value taken out of an already-validated document is canonical
 * and checked by construction, and sorting keys that are already in order is
 * the single most expensive thing that clone does.
 *
 * Use this only on values that came from a validated document or from
 * {@link snapshotProjectInput}. It performs no checks: a non-JSON value is
 * copied by reference rather than reported.
 */
export function cloneJson<T extends JsonValue>(value: T): T {
  return plainClone(value) as T;
}

function plainClone(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const entry of value) result.push(plainClone(entry as JsonValue));
    return result;
  }
  const source = value as Record<string, JsonValue>;
  const result: Record<string, JsonValue> = {};
  for (const key in source) {
    const entry = plainClone(source[key] as JsonValue);
    // `__proto__` and the rest of `Object.prototype` resolve on a fresh object,
    // where a plain store would move the prototype instead of adding a
    // property. `JSON.parse` defines them; so does this.
    if (key in result) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: entry,
      });
    } else {
      result[key] = entry;
    }
  }
  return result;
}
