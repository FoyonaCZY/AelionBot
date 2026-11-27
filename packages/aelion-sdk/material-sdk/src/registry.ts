import { throwIfAborted } from '@aelionsdk/core';
import type { MaterialGraph } from '@aelionsdk/material-compiler';

import { decodeMaterialJson, verifyMaterialPackageSnapshot } from './package.js';
import { inspectPackedMaterialPackage, resolveMaterialPackageByteLimits } from './package-limits.js';
import { assertMaterialDefinitionShape, assertMaterialGraphShape } from './package-shape.js';
import { snapshotMaterialPackage } from './package-snapshot.js';
import type { MaterialTrustStore, SignedMaterialPackage } from './security.js';
import type {
  MaterialDefinition,
  MaterialPackageByteLimitOptions,
  MaterialPackageReference,
  MaterialPackageResolver,
  PackedMaterialPackage,
  ResolvedMaterial,
} from './types.js';
import { validateAuthoredMaterial } from './validation.js';

export interface InstallMaterialPackageOptions {
  readonly expectedIntegrity?: string;
  /** Required in addition to a trusted-code manifest. Authorization is never inferred. */
  readonly authorizeTrustedCode?: boolean;
  readonly trustedPublisherIds?: ReadonlySet<string>;
  /** Applied before package transport bytes are copied or its ZIP is rebuilt. */
  readonly limits?: MaterialPackageByteLimitOptions;
}

export interface MaterialRegistryOptions {
  /** Default fail-closed transport budget for install, resolve and registry snapshots. */
  readonly limits?: MaterialPackageByteLimitOptions;
}

function packageKey(packageId: string, packageVersion: string, integrity: string): string {
  return `${packageId}\0${packageVersion}\0${integrity}`;
}

function requiresTrustedCode(definition: MaterialDefinition): boolean {
  return definition.implementations.some((value) => value.type === 'shader' || value.type === 'wasm');
}

function readDefinition(packed: PackedMaterialPackage, path: string): MaterialDefinition {
  const data = packed.files.get(path);
  if (data === undefined) throw new TypeError(`MATERIAL_PACKAGE_INVALID: missing ${path}`);
  let value: unknown;
  try {
    value = decodeMaterialJson(data);
  } catch {
    throw new TypeError(`MATERIAL_PACKAGE_INVALID: definition ${path} is not valid UTF-8 JSON`);
  }
  assertMaterialDefinitionShape(value);
  return value;
}

function readGraph(packed: PackedMaterialPackage, definition: MaterialDefinition): MaterialGraph | undefined {
  const implementation = definition.implementations.find((value) => value.type === 'graph');
  if (implementation?.type !== 'graph') return undefined;
  const data = packed.files.get(implementation.graph);
  if (data === undefined) {
    throw new TypeError(`MATERIAL_PACKAGE_INVALID: missing ${implementation.graph}`);
  }
  let value: unknown;
  try {
    value = decodeMaterialJson(data);
  } catch {
    throw new TypeError(`MATERIAL_PACKAGE_INVALID: graph ${implementation.graph} is not valid UTF-8 JSON`);
  }
  assertMaterialGraphShape(value);
  return value;
}

function requirePayload(packed: PackedMaterialPackage, path: string, owner: string): void {
  if (packed.files.get(path) === undefined) {
    throw new TypeError(`MATERIAL_PACKAGE_INVALID: ${owner} references missing ${path}`);
  }
}

function validateReferencedPayloads(packed: PackedMaterialPackage, definition: MaterialDefinition): void {
  for (const resource of definition.bundledResources) {
    requirePayload(packed, resource.path, `resource ${resource.id}`);
  }
  for (const implementation of definition.implementations) {
    if (implementation.type === 'graph') {
      requirePayload(packed, implementation.graph, `graph implementation ${definition.id}`);
    } else if (implementation.type === 'wasm') {
      requirePayload(packed, implementation.module, `WASM implementation ${definition.id}`);
    } else if (implementation.backend === 'webgpu') {
      requirePayload(packed, implementation.module, `WebGPU implementation ${definition.id}`);
    } else {
      requirePayload(packed, implementation.fragmentModule, `WebGL2 implementation ${definition.id}`);
      if (implementation.vertexModule !== undefined) {
        requirePayload(packed, implementation.vertexModule, `WebGL2 implementation ${definition.id}`);
      }
    }
  }
}

export class MaterialRegistry implements MaterialPackageResolver {
  readonly #packages = new Map<string, PackedMaterialPackage>();
  readonly #limits: ReturnType<typeof resolveMaterialPackageByteLimits>;

  constructor(options: MaterialRegistryOptions = {}) {
    this.#limits = resolveMaterialPackageByteLimits(options.limits);
  }

  async install(packed: PackedMaterialPackage, options: InstallMaterialPackageOptions = {}): Promise<void> {
    const limits = resolveMaterialPackageByteLimits(options.limits ?? this.#limits);
    const inspection = inspectPackedMaterialPackage(packed, limits);
    const snapshot = snapshotMaterialPackage(packed, limits, inspection);
    await verifyMaterialPackageSnapshot(snapshot, options.expectedIntegrity, limits);
    const { manifest } = snapshot;
    const trusted = manifest.package.trust === 'trusted-code';
    if (trusted) {
      if (options.authorizeTrustedCode !== true || !options.trustedPublisherIds?.has(manifest.package.publisher.id)) {
        throw new TypeError(
          'MATERIAL_TRUST_REQUIRED: trusted code requires explicit host authorization and publisher allowlist',
        );
      }
    }
    for (const entry of manifest.materials) {
      const definition = readDefinition(snapshot, entry.definition);
      if (definition.id !== entry.id || definition.kind !== entry.kind) {
        throw new TypeError(`MATERIAL_DEFINITION_INVALID: manifest identity differs for ${entry.id}`);
      }
      if (requiresTrustedCode(definition) && !trusted) {
        throw new TypeError(`MATERIAL_TRUST_REQUIRED: ${entry.id} contains code in a declarative package`);
      }
      validateReferencedPayloads(snapshot, definition);
      const graph = readGraph(snapshot, definition);
      const result = validateAuthoredMaterial({
        definition,
        ...(graph === undefined ? {} : { graph }),
      });
      if (!result.valid) {
        throw new TypeError(`MATERIAL_DEFINITION_INVALID: ${result.diagnostics.map((value) => value.code).join(', ')}`);
      }
    }
    this.#packages.set(packageKey(manifest.package.id, manifest.package.version, snapshot.integrity), snapshot);
  }

  async installSigned(
    signed: SignedMaterialPackage,
    trustStore: MaterialTrustStore,
    options: InstallMaterialPackageOptions & {
      readonly signal?: AbortSignal;
      readonly nowMs?: number;
    } = {},
  ): Promise<void> {
    await trustStore.verify(signed, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    });
    throwIfAborted(options.signal, 'Signed Material package install');
    await this.install(signed.package, options);
  }

  resolve(
    reference: Pick<MaterialPackageReference, 'packageId' | 'packageVersion' | 'packageIntegrity'>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PackedMaterialPackage> {
    throwIfAborted(options.signal, 'Material package resolve');
    const result = this.#packages.get(
      packageKey(reference.packageId, reference.packageVersion, reference.packageIntegrity),
    );
    if (result === undefined) {
      throw new ReferenceError(
        `MATERIAL_MISSING: ${reference.packageId}@${reference.packageVersion}#${reference.packageIntegrity}`,
      );
    }
    return Promise.resolve(snapshotMaterialPackage(result, this.#limits));
  }

  async installFrom(
    resolver: MaterialPackageResolver,
    reference: Pick<MaterialPackageReference, 'packageId' | 'packageVersion' | 'packageIntegrity'>,
    options: InstallMaterialPackageOptions & { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const packed = await resolver.resolve(reference, options.signal === undefined ? {} : { signal: options.signal });
    throwIfAborted(options.signal, 'Material package install');
    await this.install(packed, { ...options, expectedIntegrity: reference.packageIntegrity });
  }

  async resolveMaterial(reference: MaterialPackageReference): Promise<ResolvedMaterial> {
    const packed = await this.resolve(reference);
    const entry = packed.manifest.materials.find((value) => value.id === reference.materialId);
    if (entry === undefined) {
      throw new ReferenceError(`MATERIAL_MISSING: material ${reference.materialId}`);
    }
    const definition = readDefinition(packed, entry.definition);
    const graph = readGraph(packed, definition);
    return {
      reference,
      manifest: packed.manifest,
      definition,
      ...(graph === undefined ? {} : { graph }),
    };
  }

  uninstall(reference: Pick<MaterialPackageReference, 'packageId' | 'packageVersion' | 'packageIntegrity'>): boolean {
    return this.#packages.delete(packageKey(reference.packageId, reference.packageVersion, reference.packageIntegrity));
  }
}
