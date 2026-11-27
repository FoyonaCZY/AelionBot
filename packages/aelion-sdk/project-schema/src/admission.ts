import type { JsonValue } from '@aelionsdk/core';

export const PROJECT_INPUT_MAX_DEPTH = 64;
export const PROJECT_INPUT_MAX_NODES = 262_144;
export const PROJECT_INPUT_MAX_ARRAY_LENGTH = 16_384;
export const PROJECT_INPUT_MAX_OBJECT_KEYS = 4_096;
export const PROJECT_INPUT_MAX_PROPERTY_KEY_BYTES = 16 * 1_024;
export const PROJECT_INPUT_MAX_STRING_BYTES = 4 * 1_024 * 1_024;
export const PROJECT_INPUT_MAX_TOTAL_STRING_BYTES = 16 * 1_024 * 1_024;

type ProjectAdmissionCode = 'PROJECT_INPUT_INVALID' | 'PROJECT_INPUT_LIMIT_EXCEEDED';

/**
 * Where the walk currently is, as one array pushed and popped on descent.
 *
 * A parent-linked node per value reads better and allocates two objects for
 * every value in the document -- on a long timeline, hundreds of thousands of
 * them, thrown away immediately, for a path that is only ever read when the
 * document is about to be rejected. One array that the walk pushes and pops
 * costs nothing per value and still names the offending value exactly.
 */
type PathStack = (string | number)[];

const arrayIsArray = Array.isArray;
const defineProperty = Object.defineProperty;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf as (value: object) => object | null;
const ownKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;
const functionToString = (value: object): string =>
  // Calling through Reflect.apply deliberately avoids observing value.toString.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  reflectApply(Function.prototype.toString, value, []);

export class ProjectInputAdmissionError extends TypeError {
  public readonly code: ProjectAdmissionCode;
  public readonly path: readonly (string | number)[];

  public constructor(code: ProjectAdmissionCode, message: string, path: readonly (string | number)[]) {
    super(message);
    this.name = 'ProjectInputAdmissionError';
    this.code = code;
    this.path = path;
  }
}

function invalid(path: PathStack, message: string): never {
  throw new ProjectInputAdmissionError('PROJECT_INPUT_INVALID', message, [...path]);
}

function limit(path: PathStack, message: string): never {
  throw new ProjectInputAdmissionError('PROJECT_INPUT_LIMIT_EXCEEDED', message, [...path]);
}

function descriptor(value: object, key: PropertyKey, path: PathStack): PropertyDescriptor {
  let result: PropertyDescriptor | undefined;
  try {
    result = getOwnPropertyDescriptor(value, key);
  } catch {
    invalid(path, 'Project input contains an inaccessible property');
  }
  if (result === undefined || !('value' in result) || result.enumerable !== true) {
    invalid(path, 'Project input properties must be enumerable own data properties');
  }
  return result;
}

function arrayLength(value: unknown[], path: PathStack): number {
  let result: PropertyDescriptor | undefined;
  try {
    result = getOwnPropertyDescriptor(value, 'length');
  } catch {
    invalid(path, 'Project input contains an inaccessible array length');
  }
  if (result === undefined || !('value' in result) || !Number.isSafeInteger(result.value)) {
    invalid(path, 'Project input array length must be a safe own data property');
  }
  const length = Number(result.value);
  if (length < 0) invalid(path, 'Project input array length must be non-negative');
  if (length > PROJECT_INPUT_MAX_ARRAY_LENGTH) {
    limit(path, `Project input array exceeds ${PROJECT_INPUT_MAX_ARRAY_LENGTH.toString()} values`);
  }
  return length;
}

function inspectedPrototype(value: object, path: PathStack): object | null {
  let prototype: object | null;
  try {
    prototype = getPrototypeOf(value);
  } catch {
    invalid(path, 'Project input contains an inaccessible prototype');
  }
  return prototype;
}

function inspectedDescriptor(value: object, key: PropertyKey, path: PathStack): PropertyDescriptor | undefined {
  try {
    return getOwnPropertyDescriptor(value, key);
  } catch {
    invalid(path, 'Project input contains an inaccessible prototype property');
  }
}

function isNativeConstructorFor(prototype: object, expectedName: 'Array' | 'Object', path: PathStack): boolean {
  const constructorDescriptor = inspectedDescriptor(prototype, 'constructor', path);
  if (
    constructorDescriptor === undefined ||
    !('value' in constructorDescriptor) ||
    constructorDescriptor.enumerable !== false ||
    typeof constructorDescriptor.value !== 'function'
  ) {
    return false;
  }
  const constructor = constructorDescriptor.value as object;
  const prototypeDescriptor = inspectedDescriptor(constructor, 'prototype', path);
  if (
    prototypeDescriptor === undefined ||
    !('value' in prototypeDescriptor) ||
    prototypeDescriptor.value !== prototype
  ) {
    return false;
  }
  let source: string;
  try {
    source = functionToString(constructor);
  } catch {
    return false;
  }
  return source.replaceAll(/\s+/gu, ' ') === `function ${expectedName}() { [native code] }`;
}

function isPlainObjectPrototype(prototype: object, path: PathStack): boolean {
  return inspectedPrototype(prototype, path) === null && isNativeConstructorFor(prototype, 'Object', path);
}

function recordPrototype(value: object, kind: 'array' | 'object', path: PathStack): void {
  const prototype = inspectedPrototype(value, path);
  if (prototype === null) return;
  const accepted =
    kind === 'object'
      ? prototype === Object.prototype || isPlainObjectPrototype(prototype, path)
      : prototype === Array.prototype ||
        (arrayIsArray(prototype) &&
          isNativeConstructorFor(prototype, 'Array', path) &&
          (() => {
            const parent = inspectedPrototype(prototype, path);
            return parent !== null && isPlainObjectPrototype(parent, path);
          })());
  if (!accepted) {
    invalid(path, 'Project input must contain only plain JSON objects and arrays');
  }
}

function inspectedKeys(value: object, path: PathStack): readonly PropertyKey[] {
  let keys: readonly PropertyKey[];
  try {
    keys = ownKeys(value);
  } catch {
    invalid(path, 'Project input contains inaccessible properties');
  }
  return keys;
}

/**
 * Exact UTF-8 byte length without allocating an encoded copy. Lone surrogates
 * count as the three bytes `TextEncoder` spends on their U+FFFD replacement, so
 * this agrees with the encoder for every input.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
      continue;
    }
    if (code < 0x800) {
      bytes += 2;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
    }
    bytes += 3;
  }
  return bytes;
}

function byteLength(value: string, maximum: number, path: PathStack, scope: string): number {
  // A UTF-16 code unit contributes at least one UTF-8 byte, so this cheap
  // preflight avoids walking a multi-megabyte attacker-controlled string. JSON
  // escaping can expand the canonical document further, but this admission
  // budget is explicitly the decoded UTF-8 payload budget rather than a
  // serialized-file-size limit.
  if (value.length > maximum) limit(path, `${scope} exceeds ${maximum.toString()} UTF-8 bytes`);
  const bytes = utf8ByteLength(value);
  if (bytes > maximum) limit(path, `${scope} exceeds ${maximum.toString()} UTF-8 bytes`);
  return bytes;
}

/**
 * Defines one admitted property on a freshly created output container.
 *
 * A key that already resolves on an empty object or array is inherited from the
 * prototype, `__proto__` above all. Storing to those mutates the prototype or
 * runs an inherited setter instead of creating a property, which is exactly
 * what admission exists to prevent -- so they are defined outright. Everything
 * else is an ordinary miss, where a plain store produces the same writable,
 * enumerable, configurable own property that `defineProperty` would.
 */
function assign(target: Record<string | number, unknown>, key: string | number, value: unknown): void {
  if (key in target) {
    defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    return;
  }
  target[key] = value;
}

/** Running document-wide budgets, threaded through one walk. */
interface Budget {
  nodes: number;
  stringBytes: number;
  /** Deepest level reached, so a measured subtree can record its own extent. */
  deepest: number;
}

function countNode(budget: Budget, depth: number, path: PathStack): void {
  budget.nodes += 1;
  if (budget.nodes > PROJECT_INPUT_MAX_NODES) {
    limit(path, `Project input exceeds ${PROJECT_INPUT_MAX_NODES.toString()} JSON values`);
  }
  if (depth > PROJECT_INPUT_MAX_DEPTH) {
    limit(path, `Project input exceeds depth ${PROJECT_INPUT_MAX_DEPTH.toString()}`);
  }
  if (depth > budget.deepest) budget.deepest = depth;
}

function countString(budget: Budget, bytes: number, path: PathStack): void {
  budget.stringBytes += bytes;
  if (budget.stringBytes > PROJECT_INPUT_MAX_TOTAL_STRING_BYTES) {
    limit(path, `Project input strings exceed ${PROJECT_INPUT_MAX_TOTAL_STRING_BYTES.toString()} total UTF-8 bytes`);
  }
}

function admitNumber(value: number, path: PathStack): void {
  if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    invalid(path, 'Project input contains a non-canonical number');
  }
}

function admitValue(
  current: unknown,
  depth: number,
  path: PathStack,
  budget: Budget,
  seen: WeakSet<object>,
): JsonValue {
  countNode(budget, depth, path);

  if (current === null || typeof current === 'boolean') return current;
  if (typeof current === 'number') {
    admitNumber(current, path);
    return current;
  }
  if (typeof current === 'string') {
    countString(budget, byteLength(current, PROJECT_INPUT_MAX_STRING_BYTES, path, 'Project input string'), path);
    return current;
  }
  if (typeof current !== 'object') invalid(path, 'Project input contains a non-JSON value');
  if (seen.has(current)) invalid(path, 'Project input contains a cycle or shared object');
  seen.add(current);

  if (arrayIsArray(current)) {
    recordPrototype(current, 'array', path);
    const length = arrayLength(current, path);
    const keys = inspectedKeys(current, path);
    if (keys.length !== length + 1) {
      invalid(path, 'Project input arrays must be dense and contain no extra properties');
    }
    const remaining = new Set<string>();
    for (const key of keys) {
      if (typeof key !== 'string') {
        invalid(path, 'Project input arrays must contain only numeric index properties');
      }
      remaining.add(key);
    }
    if (!remaining.delete('length')) {
      invalid(path, 'Project input arrays must be dense and contain no extra properties');
    }
    for (let index = 0; index < length; index += 1) {
      if (!remaining.delete(index.toString())) {
        invalid(path, 'Project input arrays must be dense and contain no extra properties');
      }
    }
    if (remaining.size !== 0) {
      invalid(path, 'Project input arrays must be dense and contain no extra properties');
    }
    const output: unknown[] = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      path.push(index);
      assign(
        output as unknown as Record<number, unknown>,
        index,
        admitValue(descriptor(current, index.toString(), path).value, depth + 1, path, budget, seen),
      );
      path.pop();
    }
    return output as JsonValue;
  }

  recordPrototype(current, 'object', path);
  const keys = inspectedKeys(current, path);
  if (keys.length > PROJECT_INPUT_MAX_OBJECT_KEYS) {
    limit(path, `Project input object exceeds ${PROJECT_INPUT_MAX_OBJECT_KEYS.toString()} properties`);
  }
  const output: Record<string | number, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') invalid(path, 'Project input contains a symbol property');
    path.push(key);
    countString(
      budget,
      byteLength(key, PROJECT_INPUT_MAX_PROPERTY_KEY_BYTES, path, 'Project input property key'),
      path,
    );
    assign(output, key, admitValue(descriptor(current, key, path).value, depth + 1, path, budget, seen));
    path.pop();
  }
  return output as JsonValue;
}

/**
 * Captures a bounded, ownership-isolated JSON snapshot before Ajv or semantic
 * validation sees caller-controlled objects. Reflection on a Proxy can still
 * invoke its traps; failures are caught, and no accessor getter or iterator is
 * intentionally called. After this function returns, the original value is no
 * longer observed.
 */
export function snapshotProjectInput(value: unknown): JsonValue {
  return admitValue(value, 0, [], { nodes: 0, stringBytes: 0, deepest: 0 }, new WeakSet<object>());
}

/**
 * What one already-measured subtree contributes to the document budgets.
 *
 * A commit shares every untouched entity with the previous snapshot by object
 * identity, so re-measuring them is the bulk of what checking a commit costs --
 * on a thousand-clip timeline, thousands of Items walked to discover that none
 * of them changed. Remembering the totals turns that into one lookup each.
 *
 * `depth` is the deepest level *below* the subtree's own root. A cached result
 * is only usable where the whole subtree still fits under the depth limit, and
 * the same object can be reached at a different depth by a different document,
 * so the check is made against the depth of the use rather than of the measure.
 */
interface Bounds {
  readonly nodes: number;
  readonly stringBytes: number;
  readonly depth: number;
}

/**
 * Bounds of frozen subtrees.
 *
 * Only frozen objects are recorded. A frozen subtree cannot change, so its
 * totals stay true; a mutable one could be edited between two calls and would
 * make the cache lie. `Object.isFrozen` on the root is enough because a
 * published Project snapshot is deep-frozen, and anything shallower simply
 * misses the cache on the values below it.
 *
 * Held weakly, so a released snapshot is still collectable.
 */
const boundsCache = new WeakMap<object, Bounds>();

function assertValue(current: unknown, depth: number, path: PathStack, budget: Budget): void {
  countNode(budget, depth, path);

  if (current === null || typeof current === 'boolean') return;
  if (typeof current === 'number') {
    admitNumber(current, path);
    return;
  }
  if (typeof current === 'string') {
    if (current.length > PROJECT_INPUT_MAX_STRING_BYTES) {
      limit(path, `Project input string exceeds ${PROJECT_INPUT_MAX_STRING_BYTES.toString()} UTF-8 bytes`);
    }
    const bytes = utf8ByteLength(current);
    if (bytes > PROJECT_INPUT_MAX_STRING_BYTES) {
      limit(path, `Project input string exceeds ${PROJECT_INPUT_MAX_STRING_BYTES.toString()} UTF-8 bytes`);
    }
    countString(budget, bytes, path);
    return;
  }
  if (typeof current !== 'object') invalid(path, 'Project input contains a non-JSON value');

  // The root node was already counted above; a hit contributes what is beneath
  // it, and the deepest node in it has to still fit from here.
  const cached = boundsCache.get(current);
  if (cached !== undefined) {
    if (depth + cached.depth > PROJECT_INPUT_MAX_DEPTH) {
      limit(path, `Project input exceeds depth ${PROJECT_INPUT_MAX_DEPTH.toString()}`);
    }
    budget.nodes += cached.nodes;
    if (budget.nodes > PROJECT_INPUT_MAX_NODES) {
      limit(path, `Project input exceeds ${PROJECT_INPUT_MAX_NODES.toString()} JSON values`);
    }
    countString(budget, cached.stringBytes, path);
    budget.deepest = Math.max(budget.deepest, depth + cached.depth);
    return;
  }

  const frozen = Object.isFrozen(current);
  const startNodes = budget.nodes;
  const startStringBytes = budget.stringBytes;
  const startDeepest = budget.deepest;
  if (frozen) budget.deepest = depth;

  assertContainer(current, depth, path, budget);

  if (frozen) {
    boundsCache.set(current, {
      // `nodes` excludes this node, which the caller counts on every visit.
      nodes: budget.nodes - startNodes,
      stringBytes: budget.stringBytes - startStringBytes,
      depth: budget.deepest - depth,
    });
    budget.deepest = Math.max(startDeepest, budget.deepest);
  }
}

/** Walks the members of an array or object, which have already been typed. */
function assertContainer(current: object, depth: number, path: PathStack, budget: Budget): void {
  if (arrayIsArray(current)) {
    const length = current.length;
    if (length > PROJECT_INPUT_MAX_ARRAY_LENGTH) {
      limit(path, `Project input array exceeds ${PROJECT_INPUT_MAX_ARRAY_LENGTH.toString()} values`);
    }
    for (let index = 0; index < length; index += 1) {
      path.push(index);
      assertValue(current[index], depth + 1, path, budget);
      path.pop();
    }
    return;
  }

  const keys = Object.keys(current);
  if (keys.length > PROJECT_INPUT_MAX_OBJECT_KEYS) {
    limit(path, `Project input object exceeds ${PROJECT_INPUT_MAX_OBJECT_KEYS.toString()} properties`);
  }
  const entries = current as Record<string, unknown>;
  for (const key of keys) {
    path.push(key);
    if (key.length > PROJECT_INPUT_MAX_PROPERTY_KEY_BYTES) {
      limit(path, `Project input property key exceeds ${PROJECT_INPUT_MAX_PROPERTY_KEY_BYTES.toString()} UTF-8 bytes`);
    }
    const keyBytes = utf8ByteLength(key);
    if (keyBytes > PROJECT_INPUT_MAX_PROPERTY_KEY_BYTES) {
      limit(path, `Project input property key exceeds ${PROJECT_INPUT_MAX_PROPERTY_KEY_BYTES.toString()} UTF-8 bytes`);
    }
    countString(budget, keyBytes, path);
    assertValue(entries[key], depth + 1, path, budget);
    path.pop();
  }
}

/**
 * Re-checks the bounded-shape half of {@link snapshotProjectInput} against a
 * value that is already an owned JSON snapshot, without cloning it or touching
 * the reflection machinery.
 *
 * This exists for hot paths that mutate an admitted document in place, such as
 * a transaction commit. It enforces every documented admission limit — node
 * count, depth, array length, object key count, per-string and total UTF-8
 * budgets — plus canonical numbers and JSON-only types, so a document can never
 * grow past its budget through repeated edits.
 *
 * It deliberately does **not** repeat the checks that only a hostile *caller*
 * object can fail: prototype identity, accessor properties, array density and
 * cycles. Callers must therefore route every externally supplied value through
 * {@link snapshotProjectInput} before it reaches the document. A cycle that
 * slipped through anyway still terminates here, on the node budget.
 */
export function assertAdmittedProjectInput(value: unknown): void {
  assertValue(value, 0, [], { nodes: 0, stringBytes: 0, deepest: 0 });
}
