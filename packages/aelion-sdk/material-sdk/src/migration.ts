import type { JsonValue } from '@aelionsdk/core';

import { canonicalMaterialBytes } from './canonical.js';

export type MaterialMigrationDomain = 'protocol' | 'package' | 'definition' | 'node-set';

export interface MaterialMigration {
  readonly id: string;
  readonly domain: MaterialMigrationDomain;
  readonly from: string;
  readonly to: string;
  migrate(value: JsonValue): JsonValue;
}

export interface MaterialMigrationReport {
  readonly domain: MaterialMigrationDomain;
  readonly from: string;
  readonly to: string;
  readonly migrationIds: readonly string[];
  readonly value: JsonValue;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export class MaterialMigrationRegistry {
  readonly #migrations = new Map<string, MaterialMigration>();

  public register(migration: MaterialMigration): void {
    const key = this.#key(migration.domain, migration.from, migration.to);
    if (migration.id.length === 0 || migration.from === migration.to || this.#migrations.has(key)) {
      throw new TypeError('MATERIAL_MIGRATION_INVALID');
    }
    this.#migrations.set(key, migration);
  }

  public migrate(domain: MaterialMigrationDomain, from: string, to: string, input: JsonValue): MaterialMigrationReport {
    if (from === to) {
      return { domain, from, to, migrationIds: [], value: structuredClone(input) };
    }
    const path = this.#path(domain, from, to);
    if (path === undefined) throw new ReferenceError(`MATERIAL_MIGRATION_MISSING: ${from} -> ${to}`);
    let value = structuredClone(input);
    for (const migration of path) {
      const first = migration.migrate(structuredClone(value));
      const second = migration.migrate(structuredClone(value));
      if (!equalBytes(canonicalMaterialBytes(first), canonicalMaterialBytes(second))) {
        throw new TypeError(`MATERIAL_MIGRATION_NON_DETERMINISTIC: ${migration.id}`);
      }
      value = structuredClone(first);
    }
    return { domain, from, to, migrationIds: path.map((value) => value.id), value };
  }

  #path(domain: MaterialMigrationDomain, from: string, to: string): readonly MaterialMigration[] | undefined {
    const queue: { version: string; path: readonly MaterialMigration[] }[] = [{ version: from, path: [] }];
    const visited = new Set([from]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const next = [...this.#migrations.values()]
        .filter((value) => value.domain === domain && value.from === current.version)
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const migration of next) {
        const path = [...current.path, migration];
        if (migration.to === to) return path;
        if (!visited.has(migration.to)) {
          visited.add(migration.to);
          queue.push({ version: migration.to, path });
        }
      }
    }
    return undefined;
  }

  #key(domain: MaterialMigrationDomain, from: string, to: string): string {
    return `${domain}\0${from}\0${to}`;
  }
}
