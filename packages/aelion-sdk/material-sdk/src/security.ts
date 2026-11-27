import { throwIfAborted } from '@aelionsdk/core';

import { verifyMaterialPackage } from './package.js';
import type { PackedMaterialPackage } from './types.js';

export type MaterialSignatureAlgorithm = 'Ed25519' | 'ECDSA-P256-SHA256';

export interface MaterialPackageSignature {
  readonly version: 1;
  readonly publisherId: string;
  readonly keyId: string;
  readonly algorithm: MaterialSignatureAlgorithm;
  readonly signedAtMs: number;
  readonly manifestIntegrity: string;
  readonly signatureBase64Url: string;
}

export interface SignedMaterialPackage {
  readonly package: PackedMaterialPackage;
  readonly signature: MaterialPackageSignature;
}

function signatureAlgorithm(algorithm: MaterialSignatureAlgorithm): AlgorithmIdentifier | EcdsaParams {
  return algorithm === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: { name: 'SHA-256' } };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError('Invalid base64url signature');
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function signingPayload(packed: PackedMaterialPackage): Uint8Array {
  const domain = new TextEncoder().encode(`AELION-MATERIAL-SIGNATURE-V1\n${packed.integrity}\n`);
  const payload = new Uint8Array(domain.byteLength + packed.manifestBytes.byteLength);
  payload.set(domain);
  payload.set(packed.manifestBytes, domain.byteLength);
  return payload;
}

export interface SignMaterialPackageOptions {
  readonly publisherId: string;
  readonly keyId: string;
  readonly algorithm: MaterialSignatureAlgorithm;
  readonly privateKey: CryptoKey;
  readonly signedAtMs?: number;
  readonly signal?: AbortSignal;
}

export async function signMaterialPackage(
  packed: PackedMaterialPackage,
  options: SignMaterialPackageOptions,
): Promise<SignedMaterialPackage> {
  throwIfAborted(options.signal, 'Material package signing');
  await verifyMaterialPackage(packed);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      signatureAlgorithm(options.algorithm),
      options.privateKey,
      signingPayload(packed) as BufferSource,
    ),
  );
  throwIfAborted(options.signal, 'Material package signing');
  return {
    package: packed,
    signature: {
      version: 1,
      publisherId: options.publisherId,
      keyId: options.keyId,
      algorithm: options.algorithm,
      signedAtMs: options.signedAtMs ?? Date.now(),
      manifestIntegrity: packed.integrity,
      signatureBase64Url: base64Url(signature),
    },
  };
}

export interface MaterialPublisherKey {
  readonly publisherId: string;
  readonly keyId: string;
  readonly algorithm: MaterialSignatureAlgorithm;
  readonly publicKey: CryptoKey;
  readonly validFromMs?: number;
  readonly validUntilMs?: number;
}

export interface MaterialTrustAuditEntry {
  readonly sequence: number;
  readonly timeMs: number;
  readonly action: 'key-added' | 'key-revoked' | 'package-revoked' | 'verified' | 'rejected';
  readonly publisherId?: string;
  readonly keyId?: string;
  readonly integrity?: string;
  readonly reason?: string;
}

export class MaterialTrustStore {
  readonly #keys = new Map<string, MaterialPublisherKey>();
  readonly #revokedKeys = new Map<string, string>();
  readonly #revokedPackages = new Map<string, string>();
  readonly #audit: MaterialTrustAuditEntry[] = [];
  readonly #maxAuditEntries: number;
  #sequence = 0;

  public constructor(maxAuditEntries = 1_024) {
    if (!Number.isSafeInteger(maxAuditEntries) || maxAuditEntries <= 0) {
      throw new RangeError('maxAuditEntries must be a positive safe integer');
    }
    this.#maxAuditEntries = maxAuditEntries;
  }

  public addKey(key: MaterialPublisherKey, nowMs = Date.now()): void {
    const id = this.#keyId(key.publisherId, key.keyId);
    if (this.#keys.has(id)) throw new TypeError('MATERIAL_TRUST_KEY_EXISTS');
    this.#keys.set(id, key);
    this.#record({
      timeMs: nowMs,
      action: 'key-added',
      publisherId: key.publisherId,
      keyId: key.keyId,
    });
  }

  public revokeKey(publisherId: string, keyId: string, reason: string, nowMs = Date.now()): void {
    this.#revokedKeys.set(this.#keyId(publisherId, keyId), reason);
    this.#record({ timeMs: nowMs, action: 'key-revoked', publisherId, keyId, reason });
  }

  public revokePackage(integrity: string, reason: string, nowMs = Date.now()): void {
    this.#revokedPackages.set(integrity, reason);
    this.#record({ timeMs: nowMs, action: 'package-revoked', integrity, reason });
  }

  public async verify(
    signed: SignedMaterialPackage,
    options: { readonly nowMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const nowMs = options.nowMs ?? Date.now();
    const { signature, package: packed } = signed;
    const signatureVersion: unknown = Reflect.get(signature, 'version');
    try {
      throwIfAborted(options.signal, 'Material signature verification');
      await verifyMaterialPackage(packed, signature.manifestIntegrity);
      if (
        signatureVersion !== 1 ||
        signature.manifestIntegrity !== packed.integrity ||
        signature.publisherId !== packed.manifest.package.publisher.id
      ) {
        throw new TypeError('MATERIAL_SIGNATURE_IDENTITY_MISMATCH');
      }
      const keyIdentity = this.#keyId(signature.publisherId, signature.keyId);
      const revokedKey = this.#revokedKeys.get(keyIdentity);
      if (revokedKey !== undefined) throw new TypeError(`MATERIAL_KEY_REVOKED: ${revokedKey}`);
      const revokedPackage = this.#revokedPackages.get(packed.integrity);
      if (revokedPackage !== undefined) {
        throw new TypeError(`MATERIAL_PACKAGE_REVOKED: ${revokedPackage}`);
      }
      const key = this.#keys.get(keyIdentity);
      if (key === undefined || key.algorithm !== signature.algorithm) {
        throw new TypeError('MATERIAL_PUBLISHER_UNTRUSTED');
      }
      if (
        (key.validFromMs !== undefined && signature.signedAtMs < key.validFromMs) ||
        (key.validUntilMs !== undefined && signature.signedAtMs > key.validUntilMs) ||
        signature.signedAtMs > nowMs
      ) {
        throw new TypeError('MATERIAL_SIGNATURE_TIME_INVALID');
      }
      const valid = await crypto.subtle.verify(
        signatureAlgorithm(signature.algorithm),
        key.publicKey,
        fromBase64Url(signature.signatureBase64Url) as BufferSource,
        signingPayload(packed) as BufferSource,
      );
      if (!valid) throw new TypeError('MATERIAL_SIGNATURE_INVALID');
      this.#record({
        timeMs: nowMs,
        action: 'verified',
        publisherId: signature.publisherId,
        keyId: signature.keyId,
        integrity: packed.integrity,
      });
    } catch (error) {
      this.#record({
        timeMs: nowMs,
        action: 'rejected',
        publisherId: signature.publisherId,
        keyId: signature.keyId,
        integrity: packed.integrity,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }
  }

  public auditLog(): readonly MaterialTrustAuditEntry[] {
    return this.#audit.map((entry) => ({ ...entry }));
  }

  #keyId(publisherId: string, keyId: string): string {
    return `${publisherId}\0${keyId}`;
  }

  #record(entry: Omit<MaterialTrustAuditEntry, 'sequence'>): void {
    this.#audit.push({ sequence: ++this.#sequence, ...entry });
    if (this.#audit.length > this.#maxAuditEntries) this.#audit.shift();
  }
}

export interface MaterialExecutionPermissions {
  readonly allowShader: boolean;
  readonly allowWasm: boolean;
  readonly allowedNetworkOrigins: readonly string[];
  readonly maxMemoryBytes: number;
  readonly maxExecutionMs: number;
}

export interface MaterialHostSecurityPolicy {
  readonly trustedPublisherIds: ReadonlySet<string>;
  readonly allowShader: boolean;
  readonly allowWasm: boolean;
  readonly allowedNetworkOrigins: ReadonlySet<string>;
  readonly maxMemoryBytes: number;
  readonly maxExecutionMs: number;
}

export function enforceMaterialExecutionPolicy(
  publisherId: string,
  requested: MaterialExecutionPermissions,
  host: MaterialHostSecurityPolicy,
): void {
  if (!host.trustedPublisherIds.has(publisherId)) throw new TypeError('MATERIAL_PUBLISHER_UNTRUSTED');
  if (requested.allowShader && !host.allowShader) throw new TypeError('MATERIAL_SHADER_PERMISSION_DENIED');
  if (requested.allowWasm && !host.allowWasm) throw new TypeError('MATERIAL_WASM_PERMISSION_DENIED');
  if (requested.maxMemoryBytes > host.maxMemoryBytes || requested.maxExecutionMs > host.maxExecutionMs) {
    throw new RangeError('MATERIAL_EXECUTION_BUDGET_DENIED');
  }
  for (const origin of requested.allowedNetworkOrigins) {
    if (!host.allowedNetworkOrigins.has(origin)) throw new TypeError('MATERIAL_NETWORK_PERMISSION_DENIED');
  }
}
