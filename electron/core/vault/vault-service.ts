// High-level Vault service: CRUD, metadata catalog, Bot-scoped prompt rendering, decrypt-on-use,
// active redaction registry and ephemeral SSH import tokens.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors';
import {
  CATEGORY_DEFAULT_POLICY,
  CATEGORY_DEFAULT_SINKS,
  inferFieldKind,
  isHardBlockedSink,
  isValidVaultFieldKey,
  maskPreview,
  normalizeSlug,
} from '../../../shared/vault-refs';
import {
  VAULT_CATEGORIES,
  VAULT_SINKS,
  type VaultAuditEntry,
  type VaultBinding,
  type VaultCategory,
  type VaultFieldKind,
  type VaultFieldMeta,
  type VaultItemMeta,
  type VaultItemWriteInput,
  type VaultOverview,
  type VaultSink,
} from '../../../shared/types/vault-types';
import { VaultRedactor } from './vault-redactor';
import type { VaultStore } from './vault-store';
import { validateTotpSecret } from './vault-totp';

const PROMPT_ITEM_LIMIT = 24;
const IMPORT_TOKEN_TTL_MS = 15 * 60 * 1000;
const VALID_BINDING_KINDS = new Set<VaultBinding['kind']>(['domain', 'host', 'app', 'mcp']);
const VALID_FIELD_KINDS = new Set<VaultFieldKind>([
  'text',
  'email',
  'phone',
  'password',
  'card_number',
  'cvv',
  'totp',
  'multiline_key',
]);

function resolveFieldKind(
  key: string,
  category: VaultCategory,
  value: string,
  requestedKind?: VaultFieldKind,
  existingKind?: VaultFieldKind,
): VaultFieldKind {
  if (requestedKind !== undefined && !VALID_FIELD_KINDS.has(requestedKind)) {
    throw new AppError('vault.ref_invalid', `非法的保险库字段类型：${String(requestedKind)}`);
  }
  const inferred = inferFieldKind(key, category, value);
  // Enforce invariant kind floors so caller-supplied `fieldKinds` or prior metadata cannot downgrade sensitive fields.
  if (inferred === 'multiline_key' || (category === 'ssh_key' && key === 'privateKey')) return 'multiline_key';
  if (inferred === 'totp') return 'totp';
  if (inferred === 'card_number' || inferred === 'cvv') return inferred;
  return requestedKind ?? existingKind ?? inferred;
}

function normalizeBindings(bindings?: VaultBinding[]): VaultBinding[] {
  if (!Array.isArray(bindings)) return [];
  const seen = new Set<string>();
  const out: VaultBinding[] = [];
  for (const entry of bindings) {
    if (!entry || !VALID_BINDING_KINDS.has(entry.kind) || typeof entry.value !== 'string') continue;
    const value = entry.value.trim().slice(0, 200);
    if (!value) continue;
    const key = `${entry.kind}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: entry.kind, value });
  }
  return out;
}

function normalizeTags(tags?: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().slice(0, 48);
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(tag);
  }
  return out;
}

function normalizeAllowedSinks(category: VaultCategory, sinks?: VaultSink[]): VaultSink[] | undefined {
  if (sinks === undefined) return undefined;
  const valid = new Set<VaultSink>(VAULT_SINKS);
  const filtered = [...new Set(sinks)].filter(
    (sink) => valid.has(sink) && !isHardBlockedSink(category, category === 'card' ? 'card_number' : 'text', sink),
  );
  if (category === 'card') {
    const cardSinks = filtered.filter((sink) => sink === 'vm_desktop' || sink === 'host_desktop');
    return cardSinks.length ? cardSinks : [...CATEGORY_DEFAULT_SINKS.card];
  }
  return filtered;
}

function domainMatches(bindingValue: string, domain: string): boolean {
  const b = bindingValue.trim().toLowerCase().replace(/^\*\./, '');
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
  if (!b || !d) return false;
  return d === b || d.endsWith('.' + b) || b.endsWith('.' + d) || d.includes(b);
}

export class VaultService {
  private importTokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private store: VaultStore,
    readonly redactor: VaultRedactor = new VaultRedactor(),
    private now: () => number = () => Date.now(),
  ) {}

  get available(): boolean {
    return this.store.available;
  }

  overview(): VaultOverview {
    return {
      available: this.store.available,
      items: this.store.listMeta(),
    };
  }

  listForBot(
    botId: string,
    filter: { query?: string; category?: VaultCategory; domain?: string; limit?: number } = {},
  ): VaultItemMeta[] {
    let items = this.store.listMeta().filter((item) => !item.botIds?.length || item.botIds.includes(botId));
    if (filter.category) {
      items = items.filter((item) => item.category === filter.category);
    }
    if (filter.domain?.trim()) {
      const wanted = filter.domain.trim();
      items = items.filter((item) =>
        item.bindings.some(
          (binding) => (binding.kind === 'domain' || binding.kind === 'host') && domainMatches(binding.value, wanted),
        ),
      );
    }
    if (filter.query?.trim()) {
      const terms = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      items = items.filter((item) => {
        const haystack = [
          item.slug,
          item.title,
          item.category,
          item.notes || '',
          ...item.tags,
          ...item.bindings.map((b) => `${b.kind}:${b.value}`),
          ...item.fields.map((f) => `${f.key} ${f.label || ''}`),
        ]
          .join(' ')
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    if (filter.limit !== undefined) {
      const limit = Math.max(1, Math.min(50, Math.floor(filter.limit)));
      items = items.slice(0, limit);
    }
    return items;
  }

  getMeta(id: string): VaultItemMeta | undefined {
    return this.store.getMeta(id);
  }

  findByIdOrSlug(idOrSlug: string): VaultItemMeta | undefined {
    return this.store.findMetaByIdOrSlug(idOrSlug);
  }

  /** Stages a secret imported directly on the host (e.g. SSH private key) and returns a short-lived token. */
  stageImportSecret(value: string): string {
    const now = this.now();
    for (const [token, entry] of this.importTokens) {
      if (entry.expiresAt <= now) this.importTokens.delete(token);
    }
    const token = randomUUID();
    this.importTokens.set(token, { value, expiresAt: now + IMPORT_TOKEN_TTL_MS });
    return token;
  }

  consumeImportSecret(token: string): string {
    const entry = this.importTokens.get(token);
    this.importTokens.delete(token);
    if (!entry || entry.expiresAt <= this.now()) {
      throw new AppError('vault.ref_invalid', '导入密钥令牌已过期或无效，请重新选择文件');
    }
    return entry.value;
  }

  save(input: VaultItemWriteInput, actor?: { botId?: string; runId?: string }): VaultItemMeta {
    if (!VAULT_CATEGORIES.includes(input.category)) {
      throw new AppError('vault.ref_invalid', '无效的保险库条目分类');
    }
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
    if (!title) {
      throw new AppError('vault.ref_invalid', '保险库条目标题不能为空');
    }

    const existing = input.id ? this.store.getMeta(input.id) : undefined;
    if (input.id && !existing) {
      throw new AppError('vault.not_found', '要更新的保险库条目不存在');
    }

    const resolvedIncoming: Record<string, string | null> = {};
    if (input.fields && typeof input.fields === 'object') {
      for (const [key, value] of Object.entries(input.fields)) {
        if (!isValidVaultFieldKey(key) || key === 'totp') {
          throw new AppError('vault.ref_invalid', `非法的保险库字段名：${key}`);
        }
        resolvedIncoming[key] = value;
      }
    }
    if (input.importTokens && typeof input.importTokens === 'object') {
      for (const [key, token] of Object.entries(input.importTokens)) {
        if (!isValidVaultFieldKey(key) || key === 'totp' || typeof token !== 'string' || !token) {
          throw new AppError('vault.ref_invalid', `非法的导入字段：${key}`);
        }
        resolvedIncoming[key] = this.consumeImportSecret(token);
      }
    }

    let mergedFields: Record<string, string> = {};
    if (existing) {
      try {
        mergedFields = this.store.decryptItem(existing.id);
      } catch (error) {
        const hasReplacement = Object.values(resolvedIncoming).some((val) => typeof val === 'string' && val.length > 0);
        if (!hasReplacement) throw error;
        mergedFields = {};
      }
    }

    const touchedKeys: string[] = [];
    for (const [key, value] of Object.entries(resolvedIncoming)) {
      if (value === null) {
        if (Object.hasOwn(mergedFields, key)) {
          delete mergedFields[key];
          touchedKeys.push(key);
        }
      } else if (typeof value === 'string' && value.length > 0) {
        mergedFields[key] = value;
        touchedKeys.push(key);
      }
    }

    const existingKindMap = new Map((existing?.fields || []).map((field) => [field.key, field.kind]));
    const fieldMetas: VaultFieldMeta[] = [];
    for (const [key, value] of Object.entries(mergedFields)) {
      const kind = resolveFieldKind(key, input.category, value, input.fieldKinds?.[key], existingKindMap.get(key));
      if (kind === 'totp') {
        validateTotpSecret(value);
      }
      const trimmedLen = value.trim().length;
      fieldMetas.push({
        key,
        kind,
        preview: maskPreview(value, kind),
        ...(trimmedLen > 0 && trimmedLen < 6 ? { shortValue: true } : {}),
      });
    }
    if (Object.hasOwn(mergedFields, 'totpSecret') && mergedFields.totpSecret.trim()) {
      fieldMetas.push({
        key: 'totp',
        kind: 'totp',
        preview: '••••••',
        derived: true,
      });
    }

    const id = existing?.id || randomUUID();
    const baseSlug =
      input.slug !== undefined
        ? normalizeSlug(input.slug, input.category)
        : existing?.slug || normalizeSlug(title, input.category);
    const takenSlugs = new Set(
      this.store
        .listMeta()
        .filter((item) => item.id !== id)
        .map((item) => item.slug),
    );
    let slug = baseSlug;
    for (let suffixNum = 2; takenSlugs.has(slug); suffixNum++) {
      const suffix = `-${suffixNum}`;
      slug = `${baseSlug.slice(0, 64 - suffix.length).replace(/[-_]+$/g, '')}${suffix}`;
    }

    const nowIso = new Date(this.now()).toISOString();
    const category = input.category;
    const policy =
      category === 'card' ? 'always-ask' : (input.policy ?? existing?.policy ?? CATEGORY_DEFAULT_POLICY[category]);
    const allowInAutomation =
      category === 'card'
        ? false
        : (input.allowInAutomation ??
          (existing?.category === category ? existing.allowInAutomation : undefined) ??
          false);
    const allowedSinks =
      input.allowedSinks !== undefined
        ? normalizeAllowedSinks(category, input.allowedSinks)
        : existing?.category === category
          ? normalizeAllowedSinks(category, existing.allowedSinks)
          : undefined;
    const botIds =
      input.botIds !== undefined
        ? input.botIds.length
          ? [...new Set(input.botIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
          : undefined
        : existing?.botIds;
    const notes = input.notes !== undefined ? input.notes.trim().slice(0, 300) || undefined : existing?.notes;
    const tags = input.tags !== undefined ? normalizeTags(input.tags) : existing?.tags || [];
    const bindings = input.bindings !== undefined ? normalizeBindings(input.bindings) : existing?.bindings || [];

    const meta: Omit<VaultItemMeta, 'unreadable'> = {
      id,
      slug,
      category,
      title,
      ...(notes ? { notes } : {}),
      tags,
      bindings,
      fields: fieldMetas,
      policy,
      ...(allowedSinks !== undefined ? { allowedSinks } : {}),
      ...(botIds?.length ? { botIds } : {}),
      ...(allowInAutomation ? { allowInAutomation: true } : {}),
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    };

    const saved = this.store.saveItem(meta, mergedFields);
    this.syncRedactorItem(saved.id, saved.fields, mergedFields);
    this.recordAudit({
      action: existing ? 'update' : 'save',
      itemId: saved.id,
      itemTitle: saved.title,
      fields: touchedKeys.length ? touchedKeys : Object.keys(mergedFields),
      ...(actor?.botId ? { botId: actor.botId } : {}),
      ...(actor?.runId ? { runId: actor.runId } : {}),
    });
    return saved;
  }

  delete(id: string): void {
    const removed = this.store.deleteItem(id);
    this.redactor.removeItem(id);
    this.recordAudit({
      action: 'delete',
      itemId: removed.id,
      itemTitle: removed.title,
      fields: [],
    });
  }

  /** Explicitly reveals plaintext fields for local Settings display and records a `reveal` audit event. */
  reveal(id: string): Record<string, string> {
    const meta = this.store.getMeta(id);
    if (!meta) throw new AppError('vault.not_found', '保险库条目不存在');
    const fields = this.decryptFields(id);
    this.recordAudit({
      action: 'reveal',
      itemId: meta.id,
      itemTitle: meta.title,
      fields: Object.keys(fields),
    });
    return fields;
  }

  /** Decrypts a single item's secret fields on demand and registers them in the redactor. */
  decryptFields(id: string): Record<string, string> {
    const meta = this.store.getMeta(id);
    if (!meta) throw new AppError('vault.not_found', '保险库条目不存在');
    const fields = this.store.decryptItem(id);
    this.syncRedactorItem(id, meta.fields, fields);
    return fields;
  }

  markUsed(id: string): void {
    this.store.markUsed(id, new Date(this.now()).toISOString());
  }

  recordAudit(entry: Omit<VaultAuditEntry, 'id' | 'time'>): void {
    this.store.appendAudit({
      id: randomUUID(),
      time: new Date(this.now()).toISOString(),
      ...entry,
    });
  }

  audit(query?: { itemId?: string; limit?: number }): VaultAuditEntry[] {
    return this.store.listAudit(query);
  }

  /** Renders a compact metadata-only prompt block (up to 24 entries) for the given Bot without decrypting secrets. */
  prompt(botId: string): string {
    const visible = this.listForBot(botId).filter((item) => !item.unreadable);
    if (!visible.length) return '';

    const lines = visible.slice(0, PROMPT_ITEM_LIMIT).map((item) => {
      const bindings = item.bindings.length ? item.bindings.map((b) => `${b.kind}:${b.value}`).join(', ') : '-';
      const fields = item.fields.map((f) => `${f.key}(${f.preview})`).join(', ');
      const note = item.notes ? ` | ${item.notes}` : '';
      return `- ${item.slug} | ${item.title} | ${item.category} | ${bindings} | ${fields}${note}`;
    });

    const footer = visible.length > PROMPT_ITEM_LIMIT ? `\n共 ${visible.length} 条，其余请使用 vault_list 搜索。` : '';

    return (
      '保险库可用凭据目录（跨 Bot 共享；模型永不可见明文，仅在授权通道使用 {{vault:<slug>.<field>}} 盲注）：\n' +
      lines.join('\n') +
      footer
    );
  }

  registerActiveSecrets(
    entries: Array<{ value: string; kind?: VaultFieldKind; itemId?: string; runId?: string }>,
  ): void {
    for (const entry of entries) {
      this.redactor.register(entry.value, {
        kind: entry.kind,
        itemId: entry.itemId,
        runId: entry.runId,
      });
    }
  }

  /** Returns active normal-length secret variants currently tracked in process memory. */
  activeSecrets(): string[] {
    return this.redactor.activeValues();
  }

  /** Decrypts all readable items on demand for Diagnostics / Memory redaction callbacks. */
  allSecretsForRedaction(): string[] {
    for (const id of this.store.allItemIds()) {
      try {
        this.decryptFields(id);
      } catch {
        /* Unreadable items on another machine cannot be decrypted; skip safely. */
      }
    }
    return this.redactor.activeValues();
  }

  private syncRedactorItem(id: string, fieldMetas: VaultFieldMeta[], fields: Record<string, string>): void {
    const kindMap = new Map(fieldMetas.map((meta) => [meta.key, meta.kind]));
    this.redactor.setForItem(
      id,
      Object.entries(fields).map(([key, value]) => ({
        value,
        kind: kindMap.get(key),
      })),
    );
  }
}
