import {
  addMaterialPackageBytes,
  materialPackageBudgetExceeded,
  materialUint8ArrayByteLength,
  resolveMaterialPackageByteLimits,
  validMaterialPackagePath,
} from './package-limits.js';
import type { MaterialPackageByteLimitOptions } from './types.js';

const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);
/* eslint-disable @typescript-eslint/unbound-method -- captured Map accessors are invoked with Reflect.apply */
const mapSizeGetter_ = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get;
const mapEntries = Map.prototype.entries;
const typedArrayValues = Uint8Array.prototype.values;
/* eslint-enable @typescript-eslint/unbound-method */

if (mapSizeGetter_ === undefined) throw new Error('Required Map size accessor is unavailable');
const mapSizeGetter = mapSizeGetter_;

function archiveMapSize(files: unknown): number {
  try {
    return Number(Reflect.apply(mapSizeGetter, files, []));
  } catch {
    throw new TypeError('MATERIAL_PACKAGE_INVALID: archive files must be a genuine Map');
  }
}

function archiveMapEntries(files: unknown): IterableIterator<[unknown, unknown]> {
  try {
    return Reflect.apply(mapEntries, files, []) as IterableIterator<[unknown, unknown]>;
  } catch {
    throw new TypeError('MATERIAL_PACKAGE_INVALID: archive files must be a genuine Map');
  }
}

for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  // Never dispatch through an instance Symbol.iterator. A genuine Uint8Array
  // can still define an own iterator that yields forever and bypass every byte
  // budget. The captured intrinsic iterates exactly the branded byte length.
  const values = Reflect.apply(typedArrayValues, data, []) as IterableIterator<number>;
  for (const byte of values) crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true);
  return offset + 2;
}

function writeUint32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value, true);
  return offset + 4;
}

function copyInto(output: Uint8Array, offset: number, source: Uint8Array, byteLength: number): number {
  output.set(source, offset);
  return offset + byteLength;
}

interface ZipEntry {
  readonly path: string;
  readonly data: Uint8Array;
  readonly name: Uint8Array;
  readonly byteLength: number;
  readonly checksum: number;
  readonly localOffset: number;
}

function inspectArchiveFiles(
  files: ReadonlyMap<string, Uint8Array>,
  options: MaterialPackageByteLimitOptions,
): { readonly entries: readonly ZipEntry[]; readonly archiveBytes: number } {
  const limits = resolveMaterialPackageByteLimits(options);
  const fileCount = archiveMapSize(files);
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new TypeError('MATERIAL_PACKAGE_INVALID: archive files has an invalid size');
  }
  if (fileCount > limits.maxFiles) {
    throw new RangeError(
      `MATERIAL_PACKAGE_BUDGET_EXCEEDED: archive has ${fileCount} files; limit is ${limits.maxFiles}`,
    );
  }
  const entries: ZipEntry[] = [];
  let packageBytes = 0;
  let localBytes = 0;
  let centralBytes = 0;
  let inspectedFiles = 0;
  for (const [path, data] of archiveMapEntries(files)) {
    if (typeof path !== 'string' || !validMaterialPackagePath(path)) {
      throw new TypeError('MATERIAL_PACKAGE_INVALID: unsafe ZIP path');
    }
    if (path === 'signature.json') {
      throw new TypeError('MATERIAL_PACKAGE_INVALID: signature.json is a reserved payload path');
    }
    const byteLength = materialUint8ArrayByteLength(data, `archive file ${path}`);
    const fileLimit = path === 'manifest.json' ? limits.maxManifestBytes : limits.maxFileBytes;
    if (byteLength > fileLimit) materialPackageBudgetExceeded(`file ${path}`, byteLength, fileLimit);
    packageBytes = addMaterialPackageBytes(packageBytes, byteLength, `archive file ${path}`);
    if (packageBytes > limits.maxPackageBytes) {
      materialPackageBudgetExceeded('archive package files', packageBytes, limits.maxPackageBytes);
    }
    const name = encoder.encode(path);
    if (name.byteLength > 0xffff) {
      throw new RangeError(`MATERIAL_PACKAGE_INVALID: ZIP path is too long: ${path}`);
    }
    const localSize = addMaterialPackageBytes(30 + name.byteLength, byteLength, `ZIP file ${path}`);
    const centralSize = 46 + name.byteLength;
    const localOffset = localBytes;
    localBytes = addMaterialPackageBytes(localBytes, localSize, 'ZIP local records');
    centralBytes = addMaterialPackageBytes(centralBytes, centralSize, 'ZIP central records');
    entries.push({
      path,
      data: data as Uint8Array,
      name,
      byteLength,
      checksum: crc32(data as Uint8Array),
      localOffset,
    });
    inspectedFiles += 1;
  }
  if (inspectedFiles !== fileCount) {
    throw new TypeError('MATERIAL_PACKAGE_INVALID: archive files changed during inspection');
  }
  const archiveBytes = addMaterialPackageBytes(
    addMaterialPackageBytes(localBytes, centralBytes, 'ZIP records'),
    22,
    'ZIP archive',
  );
  if (archiveBytes > limits.maxArchiveBytes) {
    materialPackageBudgetExceeded('archiveBytes', archiveBytes, limits.maxArchiveBytes);
  }
  if (localBytes > 0xffffffff || centralBytes > 0xffffffff) {
    throw new RangeError('MATERIAL_PACKAGE_BUDGET_EXCEEDED: ZIP32 offset limit exceeded');
  }
  return { entries, archiveBytes };
}

/** Writes deterministic uncompressed ZIP bytes without platform metadata or variable timestamps. */
export function createDeterministicMaterialArchive(
  files: ReadonlyMap<string, Uint8Array>,
  options: MaterialPackageByteLimitOptions = {},
): Uint8Array {
  // Compute every byte and reject the package before allocating its archive.
  const { entries, archiveBytes } = inspectArchiveFiles(files, options);
  const output = new Uint8Array(archiveBytes);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const entry of entries) {
    // UTF-8 names, no compression, fixed 1980-01-01 00:00 timestamp.
    offset = writeUint32(view, offset, 0x04034b50);
    offset = writeUint16(view, offset, 20);
    offset = writeUint16(view, offset, 0x0800);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0x0021);
    offset = writeUint32(view, offset, entry.checksum);
    offset = writeUint32(view, offset, entry.byteLength);
    offset = writeUint32(view, offset, entry.byteLength);
    offset = writeUint16(view, offset, entry.name.byteLength);
    offset = writeUint16(view, offset, 0);
    offset = copyInto(output, offset, entry.name, entry.name.byteLength);
    offset = copyInto(output, offset, entry.data, entry.byteLength);
  }
  const centralOffset = offset;
  for (const entry of entries) {
    offset = writeUint32(view, offset, 0x02014b50);
    offset = writeUint16(view, offset, 20);
    offset = writeUint16(view, offset, 20);
    offset = writeUint16(view, offset, 0x0800);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0x0021);
    offset = writeUint32(view, offset, entry.checksum);
    offset = writeUint32(view, offset, entry.byteLength);
    offset = writeUint32(view, offset, entry.byteLength);
    offset = writeUint16(view, offset, entry.name.byteLength);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint32(view, offset, 0);
    offset = writeUint32(view, offset, entry.localOffset);
    offset = copyInto(output, offset, entry.name, entry.name.byteLength);
  }
  const centralBytes = offset - centralOffset;
  offset = writeUint32(view, offset, 0x06054b50);
  offset = writeUint16(view, offset, 0);
  offset = writeUint16(view, offset, 0);
  offset = writeUint16(view, offset, entries.length);
  offset = writeUint16(view, offset, entries.length);
  offset = writeUint32(view, offset, centralBytes);
  offset = writeUint32(view, offset, centralOffset);
  offset = writeUint16(view, offset, 0);
  if (offset !== output.byteLength) throw new Error('Material ZIP size accounting mismatch');
  return output;
}
