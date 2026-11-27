import type { JsonValue } from '@aelionsdk/core';

import { canonicalMaterialBytes, sha256Hex } from './canonical.js';
import {
  addMaterialPackageBytes,
  inspectPackedMaterialPackage,
  materialPackageBudgetExceeded,
  materialUint8ArrayByteLength,
  resolveMaterialPackageByteLimits,
  validMaterialPackagePath,
} from './package-limits.js';
import {
  assertMaterialDefinitionShape,
  assertMaterialGraphShape,
  assertMaterialPackageManifestShape,
} from './package-shape.js';
import {
  MATERIAL_PACKAGE_SCHEMA,
  MATERIAL_PROTOCOL_VERSION,
  type MaterialPackageFile,
  type MaterialPackageManifest,
  type MaterialPackageByteLimitOptions,
  type PackedMaterialPackage,
  type PackMaterialPackageOptions,
} from './types.js';
import { validateAuthoredMaterial } from './validation.js';
import { createDeterministicMaterialArchive } from './zip.js';
import { snapshotMaterialPackage } from './package-snapshot.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const MEDIA_TYPE_DEFINITION = 'application/vnd.aelion.material+json';
const MEDIA_TYPE_GRAPH = 'application/vnd.aelion.material-graph+json';

function denseArraySnapshot(value: unknown, name: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`MATERIAL_PACKAGE_INVALID: ${name} must be an array`);
  }
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new RangeError(`MATERIAL_PACKAGE_BUDGET_EXCEEDED: ${name} has more than ${maximum.toString()} entries`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`MATERIAL_PACKAGE_INVALID: ${name}[${index.toString()}] must be a dense data entry`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function bytes(data: Uint8Array | string, path: string): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data);
  const byteLength = materialUint8ArrayByteLength(data, `input file ${path}`);
  const output = new Uint8Array(byteLength);
  Uint8Array.prototype.set.call(output, data);
  return output;
}

function inputByteLength(data: Uint8Array | string, path: string): number {
  if (typeof data === 'string') return encoder.encode(data).byteLength;
  return materialUint8ArrayByteLength(data, `input file ${path}`);
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function addFile(
  files: Map<string, { readonly mediaType: string; readonly data: Uint8Array }>,
  file: MaterialPackageFile,
  limits: ReturnType<typeof resolveMaterialPackageByteLimits>,
): void {
  if (!validMaterialPackagePath(file.path) || file.path === 'manifest.json' || file.path === 'signature.json') {
    throw new TypeError(`Unsafe or reserved Material package path ${file.path}`);
  }
  if (files.has(file.path)) throw new TypeError(`Duplicate Material package path ${file.path}`);
  if (files.size + 2 > limits.maxFiles) {
    throw new RangeError(
      `MATERIAL_PACKAGE_BUDGET_EXCEEDED: package would have ${files.size + 2} files; limit is ${limits.maxFiles}`,
    );
  }
  if (typeof file.mediaType !== 'string' || file.mediaType.length === 0) {
    throw new TypeError(`MATERIAL_PACKAGE_INVALID: file ${file.path} requires a media type`);
  }
  const byteLength = inputByteLength(file.data, file.path);
  if (byteLength > limits.maxFileBytes) {
    materialPackageBudgetExceeded(`file ${file.path}`, byteLength, limits.maxFileBytes);
  }
  const data = bytes(file.data, file.path);
  if (data.byteLength !== byteLength) {
    throw new TypeError(`MATERIAL_PACKAGE_INVALID: file ${file.path} changed during snapshot`);
  }
  files.set(file.path, { mediaType: file.mediaType, data });
}

/**
 * Creates a deterministic virtual AMP package. ZIP transport can be layered on top without
 * changing manifest hashes, canonical bytes, or registry semantics.
 */
export async function packMaterialPackage(options: PackMaterialPackageOptions): Promise<PackedMaterialPackage> {
  const materials = denseArraySnapshot(
    options.materials,
    'materials',
    256,
  ) as readonly PackMaterialPackageOptions['materials'][number][];
  if (materials.length === 0) throw new TypeError('A Material package cannot be empty');
  const limits = resolveMaterialPackageByteLimits(options.limits);
  const packageFiles = new Map<string, { readonly mediaType: string; readonly data: Uint8Array }>();
  for (const material of materials) {
    // Authoring and installation share one protocol contract. Reject values
    // here rather than creating a signed deterministic package that the same
    // SDK's registry is guaranteed to reject later.
    assertMaterialDefinitionShape(material.definition);
    if (material.graph !== undefined) assertMaterialGraphShape(material.graph);
    const validation = validateAuthoredMaterial(material);
    if (!validation.valid) {
      const codes = validation.diagnostics.map((value) => value.code).join(', ');
      throw new TypeError(`Material ${material.definition.id} is invalid: ${codes}`);
    }
    const definitionPath = material.definitionPath ?? `materials/${material.definition.id}.material.json`;
    addFile(
      packageFiles,
      {
        path: definitionPath,
        mediaType: MEDIA_TYPE_DEFINITION,
        data: canonicalMaterialBytes(asJsonValue(material.definition)),
      },
      limits,
    );
    if (material.graph !== undefined) {
      const implementationPath = material.definition.implementations.find((value) => value.type === 'graph')?.graph;
      const graphPath = material.graphPath ?? implementationPath;
      if (graphPath === undefined || graphPath !== implementationPath) {
        throw new TypeError(`Material ${material.definition.id} Graph path does not match Definition`);
      }
      addFile(
        packageFiles,
        {
          path: graphPath,
          mediaType: MEDIA_TYPE_GRAPH,
          data: canonicalMaterialBytes(asJsonValue(material.graph)),
        },
        limits,
      );
    }
  }
  const inputFiles = denseArraySnapshot(
    options.files ?? [],
    'files',
    Math.max(0, limits.maxFiles - 1),
  ) as readonly MaterialPackageFile[];
  // Iteration is safe over our new intrinsic Array snapshot, not caller input.
  for (const file of inputFiles) {
    addFile(packageFiles, file, limits);
  }

  let payloadBytes = 0;
  for (const [path, file] of packageFiles) {
    payloadBytes = addMaterialPackageBytes(payloadBytes, file.data.byteLength, `file ${path}`);
    if (payloadBytes > limits.maxPackageBytes) {
      materialPackageBudgetExceeded('package payloads', payloadBytes, limits.maxPackageBytes);
    }
  }

  const paths = [...packageFiles.keys()].sort();
  const fileEntries = await Promise.all(
    paths.map(async (path) => {
      const file = packageFiles.get(path);
      if (file === undefined) throw new ReferenceError(`Missing package file ${path}`);
      return {
        path,
        mediaType: file.mediaType,
        bytes: file.data.byteLength,
        sha256: await sha256Hex(file.data),
      };
    }),
  );
  const manifest: MaterialPackageManifest = {
    $schema: MATERIAL_PACKAGE_SCHEMA,
    protocolVersion: MATERIAL_PROTOCOL_VERSION,
    package: options.metadata,
    materials: materials.map((material) => ({
      id: material.definition.id,
      kind: material.definition.kind,
      definition: material.definitionPath ?? `materials/${material.definition.id}.material.json`,
    })),
    files: fileEntries,
  };
  assertMaterialPackageManifestShape(manifest);
  const manifestBytes = canonicalMaterialBytes(asJsonValue(manifest));
  if (manifestBytes.byteLength > limits.maxManifestBytes) {
    materialPackageBudgetExceeded('manifestBytes', manifestBytes.byteLength, limits.maxManifestBytes);
  }
  const packageBytes = addMaterialPackageBytes(payloadBytes, manifestBytes.byteLength, 'package files');
  if (packageBytes > limits.maxPackageBytes) {
    materialPackageBudgetExceeded('package files', packageBytes, limits.maxPackageBytes);
  }
  const integrity = `sha256:${await sha256Hex(manifestBytes)}` as const;
  const output = new Map<string, Uint8Array>();
  output.set('manifest.json', manifestBytes);
  for (const path of paths) {
    const data = packageFiles.get(path)?.data;
    if (data !== undefined) output.set(path, new Uint8Array(data));
  }
  const archiveBytes = createDeterministicMaterialArchive(output, limits);
  return {
    manifest,
    manifestBytes,
    files: output,
    archiveBytes,
    integrity,
  };
}

export async function verifyMaterialPackage(
  packed: PackedMaterialPackage,
  expectedIntegrity?: string,
  options: MaterialPackageByteLimitOptions = {},
): Promise<void> {
  // Validation is asynchronous. Snapshot synchronously so caller mutations
  // cannot change the package halfway through an integrity/trust decision.
  const inspection = inspectPackedMaterialPackage(packed, options);
  packed = snapshotMaterialPackage(packed, options, inspection);
  await verifyMaterialPackageSnapshot(packed, expectedIntegrity, inspection.limits);
}

/** Internal verification path for a package that is already ownership-isolated. */
/** @internal Ownership-isolated verification path; not exported by the package entrypoint. */
export async function verifyMaterialPackageSnapshot(
  packed: PackedMaterialPackage,
  expectedIntegrity: string | undefined,
  options: MaterialPackageByteLimitOptions,
): Promise<void> {
  const limits = resolveMaterialPackageByteLimits(options);
  assertMaterialPackageManifestShape(packed.manifest);
  const manifestBytes = canonicalMaterialBytes(asJsonValue(packed.manifest));
  if (manifestBytes.byteLength > limits.maxManifestBytes) {
    materialPackageBudgetExceeded('canonical manifest', manifestBytes.byteLength, limits.maxManifestBytes);
  }
  const storedManifest = packed.files.get('manifest.json');
  if (
    storedManifest === undefined ||
    packed.manifestBytes.byteLength !== manifestBytes.byteLength ||
    storedManifest.byteLength !== manifestBytes.byteLength ||
    packed.manifestBytes.some((value, index) => value !== manifestBytes[index]) ||
    storedManifest.some((value, index) => value !== manifestBytes[index])
  ) {
    throw new TypeError('MATERIAL_INTEGRITY_MISMATCH: canonical manifest bytes differ');
  }
  const integrity = `sha256:${await sha256Hex(manifestBytes)}`;
  if (packed.integrity !== integrity || (expectedIntegrity !== undefined && integrity !== expectedIntegrity)) {
    throw new TypeError('MATERIAL_INTEGRITY_MISMATCH: manifest integrity differs');
  }
  const declaredPaths = new Set<string>();
  let declaredPackageBytes = manifestBytes.byteLength;
  for (const entry of packed.manifest.files) {
    if (!validMaterialPackagePath(entry.path) || declaredPaths.has(entry.path)) {
      throw new TypeError(`MATERIAL_PACKAGE_INVALID: invalid or duplicate path ${entry.path}`);
    }
    if (entry.path === 'manifest.json' || entry.path === 'signature.json') {
      throw new TypeError(`MATERIAL_PACKAGE_INVALID: reserved payload path ${entry.path}`);
    }
    if (entry.bytes > limits.maxFileBytes) {
      materialPackageBudgetExceeded(`declared file ${entry.path}`, entry.bytes, limits.maxFileBytes);
    }
    declaredPackageBytes = addMaterialPackageBytes(declaredPackageBytes, entry.bytes, `declared file ${entry.path}`);
    if (declaredPackageBytes > limits.maxPackageBytes) {
      materialPackageBudgetExceeded('declared package files', declaredPackageBytes, limits.maxPackageBytes);
    }
    declaredPaths.add(entry.path);
    const data = packed.files.get(entry.path);
    if (data === undefined || data.byteLength !== entry.bytes || (await sha256Hex(data)) !== entry.sha256) {
      throw new TypeError(`MATERIAL_INTEGRITY_MISMATCH: payload ${entry.path} differs`);
    }
  }
  const actualPayloads = [...packed.files.keys()].filter((path) => path !== 'manifest.json');
  if (actualPayloads.some((path) => !declaredPaths.has(path)) || actualPayloads.length !== declaredPaths.size) {
    throw new TypeError('MATERIAL_PACKAGE_INVALID: undeclared or missing payload');
  }
  const archiveFiles = new Map<string, Uint8Array>([['manifest.json', manifestBytes]]);
  for (const entry of packed.manifest.files) {
    const data = packed.files.get(entry.path);
    if (data !== undefined) archiveFiles.set(entry.path, data);
  }
  const expectedArchive = createDeterministicMaterialArchive(archiveFiles, limits);
  if (
    packed.archiveBytes.byteLength !== expectedArchive.byteLength ||
    packed.archiveBytes.some((value, index) => value !== expectedArchive[index])
  ) {
    throw new TypeError('MATERIAL_INTEGRITY_MISMATCH: archive bytes differ from verified files');
  }
}

export function decodeMaterialJson(data: Uint8Array): unknown {
  return JSON.parse(decoder.decode(data)) as unknown;
}
