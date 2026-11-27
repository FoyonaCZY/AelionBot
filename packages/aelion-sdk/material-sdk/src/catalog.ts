import type { MaterialPackageReference } from './types.js';

export type MaterialCatalogStatus = 'active' | 'deprecated' | 'revoked';

export interface MaterialCatalogEntry {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly packageIntegrity: string;
  readonly publisherId: string;
  readonly materialIds: readonly string[];
  readonly status: MaterialCatalogStatus;
  readonly reason?: string;
  readonly publishedAtMs: number;
}

function keyOf(entry: Pick<MaterialCatalogEntry, 'packageId' | 'packageVersion'>): string {
  return `${entry.packageId}\0${entry.packageVersion}`;
}

/** Immutable-version local catalog model suitable for backing a remote marketplace adapter. */
export class MaterialCatalog {
  readonly #entries = new Map<string, MaterialCatalogEntry>();

  public publish(entry: Omit<MaterialCatalogEntry, 'status' | 'reason'>): void {
    const key = keyOf(entry);
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.packageIntegrity === entry.packageIntegrity) return;
      throw new TypeError('MATERIAL_CATALOG_VERSION_IMMUTABLE');
    }
    if (new Set(entry.materialIds).size !== entry.materialIds.length) {
      throw new TypeError('MATERIAL_CATALOG_DUPLICATE_MATERIAL');
    }
    this.#entries.set(key, { ...entry, materialIds: [...entry.materialIds], status: 'active' });
  }

  public setStatus(
    packageId: string,
    packageVersion: string,
    status: Exclude<MaterialCatalogStatus, 'active'>,
    reason: string,
  ): void {
    const key = keyOf({ packageId, packageVersion });
    const entry = this.#entries.get(key);
    if (entry === undefined) throw new ReferenceError('MATERIAL_CATALOG_MISSING');
    this.#entries.set(key, { ...entry, status, reason });
  }

  public resolve(reference: MaterialPackageReference): MaterialCatalogEntry {
    const entry = this.#entries.get(keyOf(reference));
    if (!entry?.materialIds.includes(reference.materialId)) {
      throw new ReferenceError('MATERIAL_CATALOG_MISSING');
    }
    if (entry.packageIntegrity !== reference.packageIntegrity) {
      throw new TypeError('MATERIAL_CATALOG_INTEGRITY_MISMATCH');
    }
    if (entry.status === 'revoked') throw new TypeError(`MATERIAL_CATALOG_REVOKED: ${entry.reason}`);
    return { ...entry, materialIds: [...entry.materialIds] };
  }

  public list(
    options: { readonly publisherId?: string; readonly includeRevoked?: boolean } = {},
  ): readonly MaterialCatalogEntry[] {
    return [...this.#entries.values()]
      .filter((entry) => options.publisherId === undefined || entry.publisherId === options.publisherId)
      .filter((entry) => options.includeRevoked === true || entry.status !== 'revoked')
      .sort(
        (left, right) =>
          left.packageId.localeCompare(right.packageId) || left.packageVersion.localeCompare(right.packageVersion),
      )
      .map((entry) => ({ ...entry, materialIds: [...entry.materialIds] }));
  }
}
