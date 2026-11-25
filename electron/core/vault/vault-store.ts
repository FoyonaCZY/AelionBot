// Encrypted persistence for global Vault items and a 500-entry audit ring buffer at `join(dataDir, 'vault.json')`.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../shared/errors';
import { RESERVED_VAULT_KEYS } from '../../../shared/vault-refs';
import type { VaultAuditEntry, VaultItemMeta } from '../../../shared/types/vault-types';
import { atomicJson } from '../storage/store';

export interface VaultCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
  isAvailable?: () => boolean;
}

interface StoredVaultItem extends Omit<VaultItemMeta, 'unreadable'> {
  /** Base64 ciphertext from `codec.encrypt(JSON.stringify(Record<string, string>))`. */
  encryptedFields: string;
}

export interface StoredVaultFile {
  version: 1;
  items: StoredVaultItem[];
  /** Ring buffer keeping up to the latest 500 audit records. */
  audit: VaultAuditEntry[];
}

export const VAULT_AUDIT_LIMIT = 500;

function stripEncrypted(item: StoredVaultItem, unreadable: boolean): VaultItemMeta {
  const { encryptedFields: _cipher, ...rest } = item;
  const copy = structuredClone(rest) as VaultItemMeta;
  if (unreadable) copy.unreadable = true;
  return copy;
}

/**
 * Stores encrypted Vault items and audit logs on disk with `0o600` atomic writes.
 * Never falls back to plaintext when encryption is unavailable.
 */
export class VaultStore {
  readonly file: string;
  private data: StoredVaultFile;
  private unreadableIds = new Set<string>();

  constructor(
    readonly dataDir: string,
    private codec?: VaultCodec,
  ) {
    this.file = join(dataDir, 'vault.json');
    this.data = this.load();
  }

  private load(): StoredVaultFile {
    if (!existsSync(this.file)) {
      return { version: 1, items: [], audit: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new AppError('vault.unreadable', '保险库存储文件损坏或无法解析', { cause: error });
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      throw new AppError('vault.unreadable', '保险库存储格式无效');
    }
    const raw = parsed as Partial<StoredVaultFile>;
    return {
      version: 1,
      items: (raw.items || []).filter(
        (item): item is StoredVaultItem =>
          Boolean(item) && typeof item.id === 'string' && typeof item.encryptedFields === 'string',
      ),
      audit: Array.isArray(raw.audit) ? raw.audit.slice(-VAULT_AUDIT_LIMIT) : [],
    };
  }

  private persist(next: StoredVaultFile): void {
    mkdirSync(this.dataDir, { recursive: true });
    atomicJson(this.file, next);
    this.data = next;
  }

  get available(): boolean {
    if (!this.codec) return false;
    if (this.codec.isAvailable) return Boolean(this.codec.isAvailable());
    return true;
  }

  /** Lists item metadata without decrypting any stored secrets. */
  listMeta(): VaultItemMeta[] {
    return this.data.items.map((item) => stripEncrypted(item, this.unreadableIds.has(item.id)));
  }

  getMeta(id: string): VaultItemMeta | undefined {
    const item = this.data.items.find((entry) => entry.id === id);
    return item ? stripEncrypted(item, this.unreadableIds.has(item.id)) : undefined;
  }

  /** Resolves an item by exact ID first, then by exact slug. */
  findMetaByIdOrSlug(idOrSlug: string): VaultItemMeta | undefined {
    const byId = this.data.items.find((entry) => entry.id === idOrSlug);
    if (byId) return stripEncrypted(byId, this.unreadableIds.has(byId.id));
    const bySlug = this.data.items.find((entry) => entry.slug === idOrSlug);
    return bySlug ? stripEncrypted(bySlug, this.unreadableIds.has(bySlug.id)) : undefined;
  }

  allItemIds(): string[] {
    return this.data.items.map((item) => item.id);
  }

  /** Encrypts fields and inserts or updates an item atomically, throwing `vault.encryption_unavailable` if unsafe. */
  saveItem(meta: Omit<VaultItemMeta, 'unreadable'>, plainFields: Record<string, string>): VaultItemMeta {
    if (!this.available || !this.codec) {
      throw new AppError('vault.encryption_unavailable', '系统加密存储不可用，无法保存保险库条目');
    }
    let encryptedFields: string;
    try {
      encryptedFields = this.codec.encrypt(JSON.stringify(plainFields));
    } catch (error) {
      throw new AppError('vault.encryption_unavailable', '系统加密存储不可用，无法保存保险库条目', { cause: error });
    }
    if (!encryptedFields || typeof encryptedFields !== 'string') {
      throw new AppError('vault.encryption_unavailable', '系统加密存储不可用，无法保存保险库条目');
    }
    const stored: StoredVaultItem = { ...structuredClone(meta), encryptedFields };
    const items = [...this.data.items];
    const index = items.findIndex((entry) => entry.id === meta.id);
    if (index >= 0) items[index] = stored;
    else items.push(stored);

    this.persist({ ...this.data, items });
    this.unreadableIds.delete(meta.id);
    return stripEncrypted(stored, false);
  }

  /** Decrypts a single item's secret fields on demand; marks the item unreadable if decryption fails. */
  decryptItem(id: string): Record<string, string> {
    const item = this.data.items.find((entry) => entry.id === id);
    if (!item) throw new AppError('vault.not_found', '保险库条目不存在');
    if (!this.codec || !this.available) {
      this.unreadableIds.add(id);
      throw new AppError('vault.unreadable', '当前系统加密存储不可用，无法读取该条目');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(this.codec.decrypt(item.encryptedFields));
    } catch (error) {
      this.unreadableIds.add(id);
      throw new AppError('vault.unreadable', '无法解密该保险库条目，可能来自另一台设备且未恢复备份密钥', {
        cause: error,
      });
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      this.unreadableIds.add(id);
      throw new AppError('vault.unreadable', '保险库条目密文内容格式无效');
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
      if (RESERVED_VAULT_KEYS.has(key) || typeof value !== 'string') continue;
      result[key] = value;
    }
    this.unreadableIds.delete(id);
    return result;
  }

  markUsed(id: string, lastUsedAt: string): void {
    const index = this.data.items.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const items = [...this.data.items];
    items[index] = { ...items[index], lastUsedAt };
    this.persist({ ...this.data, items });
  }

  deleteItem(id: string): VaultItemMeta {
    const index = this.data.items.findIndex((entry) => entry.id === id);
    if (index < 0) throw new AppError('vault.not_found', '保险库条目不存在');
    const removed = this.data.items[index];
    const items = this.data.items.filter((entry) => entry.id !== id);
    this.persist({ ...this.data, items });
    this.unreadableIds.delete(id);
    return stripEncrypted(removed, false);
  }

  appendAudit(entry: VaultAuditEntry): void {
    const audit = [...this.data.audit, structuredClone(entry)];
    if (audit.length > VAULT_AUDIT_LIMIT) {
      audit.splice(0, audit.length - VAULT_AUDIT_LIMIT);
    }
    this.persist({ ...this.data, audit });
  }

  /** Returns newest-first audit entries, optionally filtered by `itemId`. */
  listAudit(query?: { itemId?: string; limit?: number }): VaultAuditEntry[] {
    const filtered = query?.itemId ? this.data.audit.filter((entry) => entry.itemId === query.itemId) : this.data.audit;
    const limit = Math.max(1, Math.min(VAULT_AUDIT_LIMIT, Math.floor(query?.limit ?? VAULT_AUDIT_LIMIT)));
    return filtered
      .slice(-limit)
      .reverse()
      .map((entry) => structuredClone(entry));
  }
}
