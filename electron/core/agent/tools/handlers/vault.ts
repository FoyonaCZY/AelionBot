import { AppError } from '../../../../../shared/errors';
import {
  VAULT_ACCESS_POLICIES,
  VAULT_CATEGORIES,
  type VaultAccessPolicy,
  type VaultBinding,
  type VaultCategory,
  type VaultFieldKind,
  type VaultInputFieldSpec,
} from '../../../../../shared/types/vault-types';
import { inferFieldKind, isValidVaultFieldKey } from '../../../../../shared/vault-refs';
import { unregisteredTool, type ToolContext, type ToolHandler } from '../context';
import { requiredText } from '../validation';

const BINDING_KINDS: ReadonlySet<VaultBinding['kind']> = new Set(['domain', 'app', 'mcp', 'host']);
const VAULT_FIELD_KINDS: ReadonlySet<VaultFieldKind> = new Set([
  'text',
  'password',
  'email',
  'phone',
  'card_number',
  'cvv',
  'totp',
  'multiline_key',
]);

function assertNotNonOwnerConnector({ runId, deps }: Pick<ToolContext, 'runId' | 'deps'>): void {
  const connector = deps.store.humanRunMessage(runId)?.connector;
  if (connector && !connector.owner) {
    throw new AppError('vault.context_not_allowed', '当前连接器会话发送者不是所有者，禁止访问保险库');
  }
}

function parseCategory(raw: unknown): VaultCategory {
  if (typeof raw !== 'string' || !VAULT_CATEGORIES.includes(raw as VaultCategory)) {
    throw new AppError('vault.ref_invalid', '无效的保险库分类');
  }
  return raw as VaultCategory;
}

function parseBindings(raw: unknown): VaultBinding[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 16) {
    throw new AppError('vault.ref_invalid', 'bindings 必须是最多 16 项的数组');
  }
  const out: VaultBinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError('vault.ref_invalid', 'bindings 元素格式无效');
    }
    const kind = (entry as { kind?: unknown }).kind;
    const value = (entry as { value?: unknown }).value;
    if (
      typeof kind !== 'string' ||
      !BINDING_KINDS.has(kind as VaultBinding['kind']) ||
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 200
    ) {
      throw new AppError('vault.ref_invalid', 'bindings 条目格式无效');
    }
    out.push({ kind: kind as VaultBinding['kind'], value: value.trim() });
  }
  return out;
}

function optionalShortString(value: unknown, fieldName: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError('vault.ref_invalid', `无效参数：${fieldName}`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 12) {
    throw new AppError('vault.ref_invalid', 'tags 必须是最多 12 项的字符串数组');
  }
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length > 32) {
      throw new AppError('vault.ref_invalid', 'tags 元素格式无效');
    }
    const trimmed = entry.trim();
    if (trimmed) tags.push(trimmed);
  }
  return tags;
}

function parsePolicy(raw: unknown): VaultAccessPolicy | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !VAULT_ACCESS_POLICIES.includes(raw as VaultAccessPolicy)) {
    throw new AppError('vault.ref_invalid', '无效的保险库审批策略');
  }
  return raw as VaultAccessPolicy;
}

function parseInputFields(raw: unknown, category: VaultCategory): VaultInputFieldSpec[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) {
    throw new AppError('vault.ref_invalid', 'fields 需要 1–12 个字段定义');
  }
  const seenKeys = new Set<string>();
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError('vault.ref_invalid', 'fields 条目格式无效');
    }
    const item = entry as Record<string, unknown>;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!key || !isValidVaultFieldKey(key) || key === 'totp' || seenKeys.has(key)) {
      throw new AppError('vault.ref_invalid', `非法的或重复的字段键名：${key || '(empty)'}`);
    }
    if (!label || label.length > 80) {
      throw new AppError('vault.ref_invalid', `字段 ${key} 缺少有效 label`);
    }
    seenKeys.add(key);
    let kind: VaultFieldKind;
    if (item.kind !== undefined) {
      if (typeof item.kind !== 'string' || !VAULT_FIELD_KINDS.has(item.kind as VaultFieldKind)) {
        throw new AppError('vault.ref_invalid', `字段 ${key} 的 kind 无效`);
      }
      kind = item.kind as VaultFieldKind;
    } else {
      kind = inferFieldKind(key, category, '');
    }
    const placeholder = optionalShortString(item.placeholder, `${key}.placeholder`, 120);
    return {
      key,
      label,
      kind,
      ...(typeof item.required === 'boolean' ? { required: item.required } : {}),
      ...(placeholder ? { placeholder } : {}),
    };
  });
}

export const VAULT_HANDLERS: Record<string, ToolHandler> = {
  vault_list: (ctx) => {
    const { bot, args, name, deps } = ctx;
    if (!deps.vault) throw unregisteredTool(name);
    assertNotNonOwnerConnector(ctx);

    const query = optionalShortString(args.query, 'query', 200);
    const domain = optionalShortString(args.domain, 'domain', 200);
    const category = args.category !== undefined ? parseCategory(args.category) : undefined;
    let limit: number | undefined;
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) {
        throw new AppError('vault.ref_invalid', 'limit 必须是 1–50 的整数');
      }
      limit = args.limit;
    }

    const items = deps.vault.listForBot(bot.id, { query, category, domain, limit });
    return {
      available: deps.vault.available,
      items,
    };
  },

  vault_save: (ctx) => {
    const { bot, args, name, runId, deps } = ctx;
    if (!deps.vault) throw unregisteredTool(name);
    assertNotNonOwnerConnector(ctx);

    const category = parseCategory(args.category);
    const title = requiredText(args, 'title', 120).trim();
    const id = optionalShortString(args.id, 'id', 100);
    const slug = optionalShortString(args.slug, 'slug', 64);
    const notes = optionalShortString(args.notes, 'notes', 300);
    const tags = parseTags(args.tags);
    const bindings = parseBindings(args.bindings);
    const policy = parsePolicy(args.policy);

    const rawFields = args.fields;
    if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
      throw new AppError('vault.ref_invalid', 'fields 必须是非空键值对对象');
    }
    const fieldEntries = Object.entries(rawFields as Record<string, unknown>);
    if (!fieldEntries.length) {
      throw new AppError('vault.ref_invalid', 'fields 至少需要一个字段');
    }

    const fields: Record<string, string | null> = {};
    const scrubFields: Array<{ key: string; value: string }> = [];
    for (const [key, value] of fieldEntries) {
      if (!isValidVaultFieldKey(key) || key === 'totp') {
        throw new AppError('vault.ref_invalid', `非法的保险库字段名：${key}`);
      }
      if (value === null && id) {
        fields[key] = null;
        continue;
      }
      if (typeof value !== 'string' || !value || value.length > 32000) {
        throw new AppError('vault.ref_invalid', `字段 ${key} 必须是非空字符串（不超过 32000 字符）`);
      }
      fields[key] = value;
      scrubFields.push({ key, value });
    }

    const item = deps.vault.save(
      {
        ...(id ? { id } : {}),
        ...(slug ? { slug } : {}),
        category,
        title,
        ...(notes !== undefined ? { notes } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(bindings !== undefined ? { bindings } : {}),
        fields,
        ...(policy ? { policy } : {}),
      },
      { botId: bot.id, runId },
    );

    return {
      saved: true,
      item,
      hint: `已加密保存到保险库（slug: ${item.slug}）。后续请使用 {{vault:${item.slug}.<field>}} 盲注使用，模型不可见明文。`,
      ...(scrubFields.length ? { __scrubFields: scrubFields } : {}),
    };
  },

  vault_request: async (ctx) => {
    const { bot, args, name, signal, runId, options, deps } = ctx;
    if (!deps.vault || !deps.interactions) throw unregisteredTool(name);
    if (options.groupOrigin || options.privateSessionId || options.peerOrigin) {
      throw new AppError('vault.context_not_allowed', 'vault_request 仅可在 1v1 交互会话中使用');
    }
    assertNotNonOwnerConnector(ctx);

    const category = parseCategory(args.category);
    const title = requiredText(args, 'title', 120).trim();
    const reason = requiredText(args, 'reason', 500).trim();
    const suggestedSlug = optionalShortString(args.suggestedSlug, 'suggestedSlug', 64);
    const existingItemId = optionalShortString(args.existingItemId, 'existingItemId', 100);
    const bindings = parseBindings(args.bindings);
    const fields = parseInputFields(args.fields, category);

    const result = await deps.interactions.requestVaultInput(
      bot.id,
      runId,
      {
        title,
        reason,
        category,
        ...(suggestedSlug ? { suggestedSlug } : {}),
        ...(bindings ? { bindings } : {}),
        ...(existingItemId ? { existingItemId } : {}),
        fields,
      },
      signal,
      (vaultInput, actor) => deps.vault!.save(vaultInput, actor),
    );

    if (!result.saved || !result.item) {
      return { saved: false, cancelled: true };
    }
    return {
      saved: true,
      item: result.item,
      hint: `已加密保存到保险库（slug: ${result.item.slug}），可使用 {{vault:${result.item.slug}.<field>}} 盲注，模型不可见明文。`,
    };
  },
};
