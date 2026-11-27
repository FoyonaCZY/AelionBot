import type { MaterialPackageByteLimitOptions, MaterialPackageByteLimits, PackedMaterialPackage } from './types.js';

export const MATERIAL_PACKAGE_MAX_FILES = 256;
export const MATERIAL_PACKAGE_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MATERIAL_PACKAGE_MAX_MANIFEST_BYTES = 256 * 1024;
export const MATERIAL_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const MATERIAL_PACKAGE_MAX_ARCHIVE_BYTES = 65 * 1024 * 1024;

const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
/* eslint-disable @typescript-eslint/unbound-method -- captured built-in accessors are invoked with Reflect.apply below */
const typedArrayByteLengthGetter_ = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const typedArrayNameGetter_ = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const mapSizeGetter_ = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get;
/* eslint-enable @typescript-eslint/unbound-method */

if (typedArrayByteLengthGetter_ === undefined || typedArrayNameGetter_ === undefined || mapSizeGetter_ === undefined) {
  throw new Error('Required built-in collection accessors are unavailable');
}
const typedArrayByteLengthGetter = typedArrayByteLengthGetter_;
const typedArrayNameGetter = typedArrayNameGetter_;
const mapSizeGetter = mapSizeGetter_;
// eslint-disable-next-line @typescript-eslint/unbound-method -- receiver supplied via Reflect.apply
const mapEntries = Map.prototype.entries;
const pathEncoder = new TextEncoder();

export const DEFAULT_MATERIAL_PACKAGE_BYTE_LIMITS: MaterialPackageByteLimits = Object.freeze({
  maxFiles: MATERIAL_PACKAGE_MAX_FILES,
  maxFileBytes: MATERIAL_PACKAGE_MAX_FILE_BYTES,
  maxManifestBytes: MATERIAL_PACKAGE_MAX_MANIFEST_BYTES,
  maxPackageBytes: MATERIAL_PACKAGE_MAX_BYTES,
  maxArchiveBytes: MATERIAL_PACKAGE_MAX_ARCHIVE_BYTES,
});

export interface InspectedMaterialPackageFile {
  readonly path: string;
  readonly data: Uint8Array;
  readonly byteLength: number;
}

export interface MaterialPackageTransportInspection {
  readonly limits: MaterialPackageByteLimits;
  readonly integrity: PackedMaterialPackage['integrity'];
  readonly manifestBytes: Uint8Array;
  readonly manifestByteLength: number;
  readonly archiveBytes: Uint8Array;
  readonly archiveByteLength: number;
  readonly files: readonly InspectedMaterialPackageFile[];
  readonly packageBytes: number;
}

function invalid(message: string): never {
  throw new TypeError(`MATERIAL_PACKAGE_INVALID: ${message}`);
}

function transportField(record: unknown, key: string): unknown {
  if (record === null || typeof record !== 'object') invalid('package must be an object');
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    invalid(`package field ${key} is inaccessible`);
  }
  if (descriptor === undefined || !('value' in descriptor)) {
    invalid(`package field ${key} must be an own data property`);
  }
  return descriptor.value;
}

export function materialPackageBudgetExceeded(scope: string, actual: number, limit: number): never {
  throw new RangeError(`MATERIAL_PACKAGE_BUDGET_EXCEEDED: ${scope} is ${actual} bytes; limit is ${limit} bytes`);
}

function limit(name: keyof MaterialPackageByteLimits, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(
      `MATERIAL_PACKAGE_LIMIT_INVALID: ${name} must be a non-negative safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

export function resolveMaterialPackageByteLimits(
  options: MaterialPackageByteLimitOptions = {},
): MaterialPackageByteLimits {
  return Object.freeze({
    maxFiles: limit('maxFiles', options.maxFiles ?? DEFAULT_MATERIAL_PACKAGE_BYTE_LIMITS.maxFiles, ZIP_UINT16_MAX),
    maxFileBytes: limit(
      'maxFileBytes',
      options.maxFileBytes ?? DEFAULT_MATERIAL_PACKAGE_BYTE_LIMITS.maxFileBytes,
      ZIP_UINT32_MAX,
    ),
    maxManifestBytes: limit(
      'maxManifestBytes',
      options.maxManifestBytes ?? DEFAULT_MATERIAL_PACKAGE_BYTE_LIMITS.maxManifestBytes,
      ZIP_UINT32_MAX,
    ),
    maxPackageBytes: limit(
      'maxPackageBytes',
      options.maxPackageBytes ?? DEFAULT_MATERIAL_PACKAGE_BYTE_LIMITS.maxPackageBytes,
      ZIP_UINT32_MAX,
    ),
    maxArchiveBytes: limit(
      'maxArchiveBytes',
      options.maxArchiveBytes ?? DEFAULT_MATERIAL_PACKAGE_BYTE_LIMITS.maxArchiveBytes,
      ZIP_UINT32_MAX,
    ),
  });
}

export function addMaterialPackageBytes(total: number, value: number, scope: string): number {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${scope} byte length is not a non-negative safe integer`);
  }
  const next = total + value;
  if (!Number.isSafeInteger(next)) invalid(`${scope} byte total exceeds safe integer range`);
  return next;
}

export function materialUint8ArrayByteLength(value: unknown, scope: string): number {
  let name: unknown;
  let byteLength: unknown;
  try {
    name = Reflect.apply(typedArrayNameGetter, value, []);
    byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []);
  } catch {
    invalid(`${scope} must be a genuine Uint8Array`);
  }
  if (name !== 'Uint8Array' || !Number.isSafeInteger(byteLength) || Number(byteLength) < 0) {
    invalid(`${scope} must be a genuine Uint8Array with a safe byte length`);
  }
  return Number(byteLength);
}

export function copyMaterialBytes(value: Uint8Array, expectedByteLength: number, scope: string): Uint8Array {
  const actualByteLength = materialUint8ArrayByteLength(value, scope);
  if (actualByteLength !== expectedByteLength) invalid(`${scope} changed during snapshot`);
  const output = new Uint8Array(actualByteLength);
  try {
    Uint8Array.prototype.set.call(output, value);
  } catch {
    invalid(`${scope} could not be snapshotted`);
  }
  return output;
}

function materialMapSize(value: unknown): number {
  let size: unknown;
  try {
    size = Reflect.apply(mapSizeGetter, value, []);
  } catch {
    invalid('files must be a genuine Map');
  }
  if (!Number.isSafeInteger(size) || Number(size) < 0) invalid('files has an invalid size');
  return Number(size);
}

function materialMapEntries(value: unknown): IterableIterator<[unknown, unknown]> {
  try {
    return Reflect.apply(mapEntries, value, []) as IterableIterator<[unknown, unknown]>;
  } catch {
    invalid('files must be a genuine Map');
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validMaterialPackagePath(path: unknown): path is string {
  if (typeof path !== 'string' || !isWellFormedUnicode(path)) return false;
  const segments = path.split('/');
  return (
    path.length > 0 &&
    pathEncoder.encode(path).byteLength <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

export function inspectPackedMaterialPackage(
  packed: PackedMaterialPackage,
  options: MaterialPackageByteLimitOptions = {},
): MaterialPackageTransportInspection {
  const integrity = transportField(packed, 'integrity');
  if (typeof integrity !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(integrity)) {
    invalid('integrity must be a sha256 digest');
  }
  const limits = resolveMaterialPackageByteLimits(options);
  const manifestBytes = transportField(packed, 'manifestBytes') as Uint8Array;
  const manifestByteLength = materialUint8ArrayByteLength(manifestBytes, 'manifestBytes');
  if (manifestByteLength > limits.maxManifestBytes) {
    materialPackageBudgetExceeded('manifestBytes', manifestByteLength, limits.maxManifestBytes);
  }
  const archiveBytes = transportField(packed, 'archiveBytes') as Uint8Array;
  const archiveByteLength = materialUint8ArrayByteLength(archiveBytes, 'archiveBytes');
  if (archiveByteLength > limits.maxArchiveBytes) {
    materialPackageBudgetExceeded('archiveBytes', archiveByteLength, limits.maxArchiveBytes);
  }

  const packedFiles = transportField(packed, 'files');
  const size = materialMapSize(packedFiles);
  if (size > limits.maxFiles) {
    throw new RangeError(`MATERIAL_PACKAGE_BUDGET_EXCEEDED: package has ${size} files; limit is ${limits.maxFiles}`);
  }
  const files: InspectedMaterialPackageFile[] = [];
  let packageBytes = 0;
  for (const [path, data] of materialMapEntries(packedFiles)) {
    if (typeof path !== 'string' || !validMaterialPackagePath(path)) {
      invalid('unsafe file path');
    }
    if (path === 'signature.json') invalid('signature.json is a reserved payload path');
    const byteLength = materialUint8ArrayByteLength(data, `file ${path}`);
    const fileLimit = path === 'manifest.json' ? limits.maxManifestBytes : limits.maxFileBytes;
    if (byteLength > fileLimit) materialPackageBudgetExceeded(`file ${path}`, byteLength, fileLimit);
    packageBytes = addMaterialPackageBytes(packageBytes, byteLength, `file ${path}`);
    if (packageBytes > limits.maxPackageBytes) {
      materialPackageBudgetExceeded('package files', packageBytes, limits.maxPackageBytes);
    }
    files.push({ path, data: data as Uint8Array, byteLength });
  }
  if (files.length !== size) invalid('files changed during budget inspection');
  return {
    limits,
    integrity: integrity as PackedMaterialPackage['integrity'],
    manifestBytes,
    manifestByteLength,
    archiveBytes,
    archiveByteLength,
    files,
    packageBytes,
  };
}
