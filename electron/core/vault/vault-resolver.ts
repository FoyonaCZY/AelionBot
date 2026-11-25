// Vault blind-injection resolver enforcing sink capability, Bot scope, context restrictions,
// binding checks, policy state machine, human-only approval and ephemeral SSH key file handling.
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, errorCode } from '../../../shared/errors';
import { InteractionDenied } from '../agent/interactions';
import {
  allowedSinksForField,
  containsVaultMarker,
  extractVaultRefs,
  findInvalidVaultRefs,
  isHardBlockedSink,
  isHardBlockedTool,
  parseVaultRef,
  type ParsedVaultRef,
} from '../../../shared/vault-refs';
import type {
  VaultBinding,
  VaultFieldMeta,
  VaultItemMeta,
  VaultSink,
  VaultUseInteraction,
} from '../../../shared/types/vault-types';
import type { VaultService } from './vault-service';
import { generateTotp } from './vault-totp';

const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export interface VaultTargetInfo {
  kind: VaultBinding['kind'];
  value: string;
}

export interface VaultResolutionContext {
  botId: string;
  runId: string;
  sink: VaultSink;
  /** Human-readable target shown on VaultUseCard and audit records (never contains plaintext). */
  targetSummary: string;
  /** Detected destination(s) for binding verification (window app, domain, host, MCP server). */
  target?: VaultTargetInfo | VaultTargetInfo[];
  headless?: boolean;
  scheduledRun?: boolean;
  groupOrigin?: boolean;
  /** True when the group turn was triggered by a Bot message rather than directly by a human. */
  groupBotTriggered?: boolean;
  peerOrigin?: boolean;
  /** Set when running inside an IM connector session. */
  connector?: { isOwner: boolean };
  signal?: AbortSignal;
}

export type VaultApprovalDecision = 'allow' | 'allow-run' | 'deny';

export type VaultApprovalRequest = Omit<VaultUseInteraction, 'id' | 'createdAt' | 'kind' | 'phase'>;

export type VaultApprovalHandler = (
  request: VaultApprovalRequest,
  signal?: AbortSignal,
) => Promise<VaultApprovalDecision>;

export interface ResolvedVaultFile {
  envVar: string;
  content: string;
  mode: number;
  companionPassphrase?: string;
}

export interface MaterializedHostVaultFiles {
  dir: string;
  env: Record<string, string>;
  files: string[];
  cleanup: () => void;
}

export interface VmVaultPayload {
  env: Record<string, string>;
  files: Array<{ envVar: string; content: string; mode: number; passphrase?: string }>;
}

function normalizeHostOrDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .replace(/:\d+$/, '');
}

function bindingMatchesTarget(binding: VaultBinding, target: VaultTargetInfo): boolean {
  if (binding.kind !== target.kind) return false;
  const b = binding.value.trim().toLowerCase();
  const t = target.value.trim().toLowerCase();
  if (!b || !t) return false;

  if (binding.kind === 'domain') {
    const cleanB = normalizeHostOrDomain(b).replace(/^\*\./, '');
    const cleanT = normalizeHostOrDomain(t);
    return Boolean(cleanB && cleanT) && (cleanT === cleanB || cleanT.endsWith('.' + cleanB));
  }
  if (binding.kind === 'host') {
    const cleanB = normalizeHostOrDomain(b);
    const cleanT = normalizeHostOrDomain(t);
    return Boolean(cleanB && cleanT) && (cleanT === cleanB || cleanT.endsWith('.' + cleanB));
  }
  if (binding.kind === 'mcp') {
    return t === b;
  }
  // `app`: match exact app name or delimiter/word-bounded occurrence (e.g. "Chrome" in "Google Chrome - Sign in", not "mail" in "blackmail").
  if (t === b) return true;
  if (b.length < 2) return false;
  const escapedB = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[\\s\\-_.:/|\\\\()\\[\\]])${escapedB}(?:$|[\\s\\-_.:/|\\\\()\\[\\]]|\\.(?:app|exe)$)`,
    'i',
  ).test(t);
}

function evaluateBindings(
  bindings: VaultBinding[],
  targetInput?: VaultTargetInfo | VaultTargetInfo[],
): { bindingMatched: boolean; bindingMismatch: boolean } {
  const targets = Array.isArray(targetInput) ? targetInput : targetInput ? [targetInput] : [];
  if (!bindings.length || !targets.length) {
    return { bindingMatched: false, bindingMismatch: false };
  }

  // Every target kind that has bindings configured on the item must match at least one binding of that kind.
  const boundKinds = new Set(bindings.map((b) => b.kind));
  const relevantTargets = targets.filter((t) => boundKinds.has(t.kind));
  if (!relevantTargets.length) {
    return { bindingMatched: false, bindingMismatch: true };
  }

  for (const kind of new Set(relevantTargets.map((t) => t.kind))) {
    const kindTargets = relevantTargets.filter((t) => t.kind === kind);
    const kindBindings = bindings.filter((b) => b.kind === kind);
    if (!kindTargets.some((t) => kindBindings.some((b) => bindingMatchesTarget(b, t)))) {
      return { bindingMatched: false, bindingMismatch: true };
    }
  }

  return { bindingMatched: true, bindingMismatch: false };
}

function checkStringsInValue(value: unknown, visitor: (text: string) => void, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    visitor(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) checkStringsInValue(item, visitor, seen);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    visitor(key);
    checkStringsInValue(item, visitor, seen);
  }
}

function mapStringsInValue<T>(value: T, map: (text: string) => string, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === 'string') return map(value) as T;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(mapStringsInValue(item, map, seen));
    return out as T;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = mapStringsInValue(item, map, seen);
  }
  return out as T;
}

export class VaultResolver {
  /** In-memory per-run grants keyed by `runId -> Set<"${itemId}:${sink}">`. Never persisted. */
  private runGrants = new Map<string, Set<string>>();

  constructor(
    private service: VaultService,
    private approveUse?: VaultApprovalHandler,
    private now: () => number = () => Date.now(),
  ) {}

  clearRun(runId: string): void {
    this.runGrants.delete(runId);
    this.service.redactor.clearRun(runId);
  }

  /**
   * Entry-point guard for `Harness.executeTool`: rejects any `{{vault:...}}` marker on hard-blocked / non-sink tools
   * and blocks `open_app(url)` from carrying Vault references into browser URL history.
   */
  assertToolInputAllowed(toolName: string, args: unknown): void {
    if (toolName === 'computer' && args && typeof args === 'object' && !Array.isArray(args)) {
      const input = args as { action?: unknown; url?: unknown; actions?: unknown };
      const steps = input.action === 'batch' && Array.isArray(input.actions) ? input.actions : [input];
      for (const step of steps) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
        const stepObj = step as { action?: unknown; url?: unknown };
        if (stepObj.action === 'open_app' && typeof stepObj.url === 'string' && containsVaultMarker(stepObj.url)) {
          throw new AppError('vault.sink_not_allowed', '禁止将保险库凭据放入 open_app 的 URL 参数中');
        }
      }
    }
    if (!isHardBlockedTool(toolName)) return;
    checkStringsInValue(args, (text) => {
      if (containsVaultMarker(text)) {
        throw new AppError('vault.sink_not_allowed', `工具 ${toolName} 禁止使用保险库引用`);
      }
    });
  }

  /** Resolves all `{{vault:...}}` placeholders inside a single string. */
  async resolveText(text: string, ctx: VaultResolutionContext): Promise<string> {
    if (!text || !/\{\{\s*vault\s*:/i.test(text)) return text;
    const invalid = findInvalidVaultRefs(text);
    if (invalid.length) {
      throw new AppError('vault.ref_invalid', `非法的保险库引用格式：${invalid[0]}`);
    }
    const refs = extractVaultRefs(text);
    if (!refs.length) return text;
    const resolvedMap = await this.resolveRefGroup(refs, ctx);
    let out = '';
    let cursor = 0;
    for (const ref of refs) {
      out += text.slice(cursor, ref.start);
      out += resolvedMap.get(ref.raw) ?? ref.raw;
      cursor = ref.end;
    }
    out += text.slice(cursor);
    return out;
  }

  /** Recursively resolves `{{vault:...}}` placeholders across an object/array tree with grouped per-item approval. */
  async resolveObject<T>(value: T, ctx: VaultResolutionContext): Promise<T> {
    const refs: ParsedVaultRef[] = [];
    checkStringsInValue(value, (text) => {
      if (!/\{\{\s*vault\s*:/i.test(text)) return;
      const invalid = findInvalidVaultRefs(text);
      if (invalid.length) {
        throw new AppError('vault.ref_invalid', `非法的保险库引用格式：${invalid[0]}`);
      }
      refs.push(...extractVaultRefs(text));
    });
    if (!refs.length) return value;
    const resolvedMap = await this.resolveRefGroup(refs, ctx);
    return mapStringsInValue(value, (text) => {
      if (!text.includes('{{vault:')) return text;
      const localRefs = extractVaultRefs(text);
      if (!localRefs.length) return text;
      let out = '';
      let cursor = 0;
      for (const ref of localRefs) {
        out += text.slice(cursor, ref.start);
        out += resolvedMap.get(ref.raw) ?? ref.raw;
        cursor = ref.end;
      }
      out += text.slice(cursor);
      return out;
    });
  }

  /** Validates and resolves a `vaultEnv` mapping (`ENV_NAME -> "{{vault:...}}"`). */
  async resolveEnv(envMap: Record<string, string>, ctx: VaultResolutionContext): Promise<Record<string, string>> {
    const entries = Object.entries(envMap);
    if (!entries.length) return {};
    const allRefs: ParsedVaultRef[] = [];
    for (const [envVar, rawValue] of entries) {
      if (!ENV_VAR_RE.test(envVar)) {
        throw new AppError('vault.ref_invalid', `非法的环境变量名：${envVar}`);
      }
      if (typeof rawValue !== 'string') {
        throw new AppError('vault.ref_invalid', `环境变量 ${envVar} 的值必须是字符串`);
      }
      const invalid = findInvalidVaultRefs(rawValue);
      if (invalid.length) {
        throw new AppError('vault.ref_invalid', `非法的保险库引用格式：${invalid[0]}`);
      }
      const refs = extractVaultRefs(rawValue);
      if (!refs.length) {
        throw new AppError('vault.ref_invalid', `vaultEnv.${envVar} 必须包含有效的 {{vault:...}} 引用`);
      }
      allRefs.push(...refs);
    }

    const resolvedMap = await this.resolveRefGroup(allRefs, ctx);
    const out: Record<string, string> = {};
    for (const [envVar, rawValue] of entries) {
      const refs = extractVaultRefs(rawValue);
      let rendered = '';
      let cursor = 0;
      for (const ref of refs) {
        rendered += rawValue.slice(cursor, ref.start);
        rendered += resolvedMap.get(ref.raw) ?? ref.raw;
        cursor = ref.end;
      }
      rendered += rawValue.slice(cursor);
      out[envVar] = rendered;
    }
    return out;
  }

  /**
   * Validates and resolves a `vaultFiles` mapping (`ENV_NAME -> "{{vault:item.field}}"`).
   * Automatically includes companion `passphrase` when resolving an `ssh_key` item's `privateKey`.
   */
  async resolveFiles(
    filesMap: Record<string, string>,
    ctx: Omit<VaultResolutionContext, 'sink'> & { sink?: VaultSink },
  ): Promise<ResolvedVaultFile[]> {
    const entries = Object.entries(filesMap);
    if (!entries.length) return [];

    const effectiveCtx: VaultResolutionContext = { ...ctx, sink: ctx.sink ?? 'exec_file' };
    const parsedEntries: Array<{ envVar: string; parsed: { item: string; field: string }; raw: string }> = [];
    const extraFieldsByItemId = new Map<string, Set<string>>();

    for (const [envVar, rawRef] of entries) {
      if (!ENV_VAR_RE.test(envVar)) {
        throw new AppError('vault.ref_invalid', `非法的环境变量名：${envVar}`);
      }
      if (typeof rawRef !== 'string') {
        throw new AppError('vault.ref_invalid', `vaultFiles.${envVar} 必须是有效的保险库引用`);
      }
      const trimmed = rawRef.trim();
      const parsed = parseVaultRef(trimmed);
      if (!parsed) {
        throw new AppError('vault.ref_invalid', `vaultFiles.${envVar} 必须是单个 {{vault:item.field}} 引用`);
      }
      parsedEntries.push({ envVar, parsed, raw: trimmed });

      const meta = this.service.findByIdOrSlug(parsed.item);
      if (
        meta &&
        meta.category === 'ssh_key' &&
        parsed.field === 'privateKey' &&
        meta.fields.some((f) => f.key === 'passphrase')
      ) {
        let extra = extraFieldsByItemId.get(meta.id);
        if (!extra) {
          extra = new Set<string>();
          extraFieldsByItemId.set(meta.id, extra);
        }
        extra.add('passphrase');
      }
    }

    const refs: ParsedVaultRef[] = parsedEntries.map(({ raw, parsed }) => ({
      raw,
      item: parsed.item,
      field: parsed.field,
      start: 0,
      end: raw.length,
    }));

    const { values, itemsByRef, decryptedByItem } = await this.resolveRefGroupDetailed(
      refs,
      effectiveCtx,
      extraFieldsByItemId,
    );

    return parsedEntries.map(({ envVar, parsed, raw }) => {
      const meta = itemsByRef.get(raw)!;
      const fieldMeta = meta.fields.find((f) => f.key === parsed.field);
      let content = values.get(raw)!;
      if (fieldMeta?.kind === 'multiline_key' && !content.endsWith('\n')) {
        content += '\n';
      }
      const decrypted = decryptedByItem.get(meta.id);
      const companionPassphrase =
        meta.category === 'ssh_key' && parsed.field === 'privateKey' && decrypted?.passphrase
          ? decrypted.passphrase
          : undefined;

      return {
        envVar,
        content,
        mode: 0o600,
        ...(companionPassphrase !== undefined ? { companionPassphrase } : {}),
      };
    });
  }

  private async resolveRefGroup(refs: ParsedVaultRef[], ctx: VaultResolutionContext): Promise<Map<string, string>> {
    const { values } = await this.resolveRefGroupDetailed(refs, ctx);
    return values;
  }

  private async resolveRefGroupDetailed(
    refs: ParsedVaultRef[],
    ctx: VaultResolutionContext,
    extraAuditFieldsByItemId?: Map<string, Set<string>>,
  ): Promise<{
    values: Map<string, string>;
    itemsByRef: Map<string, VaultItemMeta>;
    decryptedByItem: Map<string, Record<string, string>>;
  }> {
    interface GroupedItemPlan {
      item: VaultItemMeta;
      fields: Map<string, VaultFieldMeta>;
      extraFields: string[];
    }

    const itemsByRef = new Map<string, VaultItemMeta>();
    const plans = new Map<string, GroupedItemPlan>();

    // Phase 1: Validate EVERY reference before asking for user confirmation or decrypting.
    for (const ref of refs) {
      const item = this.service.findByIdOrSlug(ref.item);
      if (!item) {
        throw new AppError('vault.not_found', `未找到保险库条目：${ref.item}`);
      }
      itemsByRef.set(ref.raw, item);

      if (item.unreadable) {
        throw new AppError('vault.unreadable', `保险库条目「${item.title}」在当前设备上无法解密，请重新录入`);
      }

      if (item.botIds?.length && !item.botIds.includes(ctx.botId)) {
        throw new AppError('vault.bot_not_allowed', `当前 Bot 无权使用保险库条目「${item.title}」`);
      }

      this.assertContextAllowed(item, ctx);

      const fieldMeta = this.lookupFieldMeta(item, ref.field);
      this.assertSinkAllowed(item, fieldMeta, ctx.sink);

      let plan = plans.get(item.id);
      if (!plan) {
        plan = {
          item,
          fields: new Map<string, VaultFieldMeta>(),
          extraFields: [...(extraAuditFieldsByItemId?.get(item.id) || [])],
        };
        plans.set(item.id, plan);
      }
      plan.fields.set(ref.field, fieldMeta);
    }

    // Phase 2: Evaluate binding & policy state machine per item, requesting human confirmation when required.
    const decisions = new Map<string, 'auto' | 'user-once' | 'user-run'>();
    for (const plan of plans.values()) {
      const allFieldKeys = [...new Set([...plan.fields.keys(), ...plan.extraFields])];
      const decision = await this.authorizeItem(plan.item, allFieldKeys, ctx);
      decisions.set(plan.item.id, decision);
    }

    // Phase 3: Decrypt-on-use, compute virtual TOTP if needed, register redactor & audit.
    const decryptedByItem = new Map<string, Record<string, string>>();
    for (const plan of plans.values()) {
      const plain = this.service.decryptFields(plan.item.id);
      decryptedByItem.set(plan.item.id, plain);
    }

    const values = new Map<string, string>();
    for (const ref of refs) {
      const item = itemsByRef.get(ref.raw)!;
      const plain = decryptedByItem.get(item.id)!;
      const fieldMeta = plans.get(item.id)!.fields.get(ref.field)!;
      let resolved: string;
      if (ref.field === 'totp') {
        const totpSecret = plain.totpSecret;
        if (!totpSecret) {
          throw new AppError('vault.field_not_found', `条目「${item.title}」缺少 totpSecret 字段`);
        }
        resolved = generateTotp(totpSecret, { timestampMs: this.now() });
      } else {
        if (!Object.hasOwn(plain, ref.field)) {
          throw new AppError('vault.field_not_found', `条目「${item.title}」不存在字段：${ref.field}`);
        }
        resolved = plain[ref.field];
      }
      values.set(ref.raw, resolved);
      this.service.redactor.recordRunSecret(
        ctx.runId,
        resolved,
        fieldMeta.kind,
        ref.field === 'totp' ? undefined : { itemId: item.id },
      );
    }

    for (const plan of plans.values()) {
      const plain = decryptedByItem.get(plan.item.id)!;
      for (const extraKey of plan.extraFields) {
        if (Object.hasOwn(plain, extraKey)) {
          const meta = plan.item.fields.find((f) => f.key === extraKey);
          this.service.redactor.recordRunSecret(ctx.runId, plain[extraKey], meta?.kind, { itemId: plan.item.id });
        }
      }
      this.service.markUsed(plan.item.id);
      this.service.recordAudit({
        action: 'use',
        itemId: plan.item.id,
        itemTitle: plan.item.title,
        fields: [...new Set([...plan.fields.keys(), ...plan.extraFields])],
        botId: ctx.botId,
        runId: ctx.runId,
        sink: ctx.sink,
        target: this.service.redactor.redactString(ctx.targetSummary, { runId: ctx.runId }).slice(0, 240),
        decision: decisions.get(plan.item.id)!,
      });
    }

    return { values, itemsByRef, decryptedByItem };
  }

  private lookupFieldMeta(item: VaultItemMeta, fieldKey: string): VaultFieldMeta {
    if (fieldKey === 'totp') {
      const derived = item.fields.find((f) => f.key === 'totp' && f.derived);
      const source = item.fields.find((f) => f.key === 'totpSecret');
      if (!derived && !source) {
        throw new AppError('vault.field_not_found', `条目「${item.title}」未配置 totpSecret`);
      }
      return derived || { key: 'totp', kind: 'totp', preview: '••••••', derived: true };
    }
    const meta = item.fields.find((f) => f.key === fieldKey);
    if (!meta) {
      throw new AppError('vault.field_not_found', `条目「${item.title}」不存在字段：${fieldKey}`);
    }
    return meta;
  }

  private assertSinkAllowed(item: VaultItemMeta, field: VaultFieldMeta, sink: VaultSink): void {
    if (isHardBlockedSink(item.category, field.kind, sink, field.key)) {
      if (
        (item.category === 'ssh_key' || field.kind === 'multiline_key') &&
        (sink === 'exec_inline' || sink === 'exec_env')
      ) {
        throw new AppError(
          'vault.sink_not_allowed',
          'SSH 私钥不能内联到命令行或环境变量中，请使用 vaultFiles 参数挂载临时只读密钥文件',
        );
      }
      if (item.category === 'card' || field.kind === 'card_number' || field.kind === 'cvv') {
        throw new AppError(
          'vault.sink_not_allowed',
          '支付卡信息仅允许注入到桌面输入通道（computer / host_computer），禁止用于命令行、Python 或 MCP',
        );
      }
      throw new AppError('vault.sink_not_allowed', `保险库字段 ${item.slug}.${field.key} 不允许通过 ${sink} 通道注入`);
    }

    const allowed = allowedSinksForField(item.category, field.kind, item.allowedSinks, field.key);
    if (!allowed.includes(sink)) {
      throw new AppError('vault.sink_not_allowed', `保险库条目「${item.title}」不允许在 ${sink} 通道使用`);
    }
  }

  private assertContextAllowed(item: VaultItemMeta, ctx: VaultResolutionContext): void {
    if (ctx.connector && !ctx.connector.isOwner) {
      throw new AppError('vault.context_not_allowed', '非连接器所有者会话禁止调用保险库凭据');
    }
    if (ctx.peerOrigin) {
      throw new AppError('vault.context_not_allowed', '私聊委托会话禁止直接越权使用保险库凭据，请先转入主会话');
    }
    if (item.category === 'card' && (ctx.groupOrigin || ctx.scheduledRun || ctx.headless)) {
      throw new AppError('vault.context_not_allowed', '支付卡信息禁止在群聊、定时自动化或无头模式下使用');
    }
    if (ctx.groupOrigin && ctx.groupBotTriggered) {
      throw new AppError('vault.context_not_allowed', '群聊中由其他 Bot 消息触发的轮次禁止使用保险库凭据');
    }
    if (ctx.scheduledRun && !item.allowInAutomation) {
      throw new AppError('vault.context_not_allowed', `条目「${item.title}」未开启定时自动化授权`);
    }
    if (ctx.headless) {
      if (item.category === 'contact') {
        if (item.policy !== 'auto') {
          throw new AppError('vault.context_not_allowed', `无头模式下联系信息「${item.title}」仅在策略为 auto 时可用`);
        }
      } else if (!item.allowInAutomation) {
        throw new AppError('vault.context_not_allowed', `无头模式下条目「${item.title}」需要显式开启自动化授权`);
      }
    }
  }

  private async authorizeItem(
    item: VaultItemMeta,
    fields: string[],
    ctx: VaultResolutionContext,
  ): Promise<'auto' | 'user-once' | 'user-run'> {
    const { bindingMatched, bindingMismatch } = evaluateBindings(item.bindings, ctx.target);

    if (ctx.headless || ctx.scheduledRun) {
      if (bindingMismatch || (item.policy === 'auto-when-bound' && item.bindings.length > 0 && !bindingMatched)) {
        throw new AppError(
          'vault.context_not_allowed',
          `条目「${item.title}」与当前目标不匹配或未确认绑定，无人值守模式禁止放行`,
        );
      }
      return 'auto';
    }

    let effectivePolicy = item.category === 'card' ? 'always-ask' : item.policy;
    if (
      ctx.groupOrigin &&
      item.category !== 'contact' &&
      (effectivePolicy === 'auto' || effectivePolicy === 'auto-when-bound')
    ) {
      effectivePolicy = 'ask-once-per-run';
    }

    const runGrantKey = `${item.id}:${ctx.sink}`;
    const hasRunGrant = Boolean(this.runGrants.get(ctx.runId)?.has(runGrantKey));

    let needsPrompt = false;
    let allowRunGrant = false;

    if (bindingMismatch) {
      needsPrompt = true;
      allowRunGrant = false;
    } else if (effectivePolicy === 'auto') {
      needsPrompt = false;
    } else if (effectivePolicy === 'auto-when-bound') {
      needsPrompt = !bindingMatched && !hasRunGrant;
      allowRunGrant = true;
    } else if (effectivePolicy === 'ask-once-per-run') {
      needsPrompt = !hasRunGrant;
      allowRunGrant = true;
    } else {
      needsPrompt = true;
      allowRunGrant = false;
    }

    if (!needsPrompt) {
      if (effectivePolicy === 'ask-once-per-run' && hasRunGrant) return 'user-run';
      if (effectivePolicy === 'auto-when-bound' && !bindingMatched && hasRunGrant) return 'user-run';
      return 'auto';
    }

    if (!this.approveUse) {
      this.service.recordAudit({
        action: 'denied',
        itemId: item.id,
        itemTitle: item.title,
        fields,
        botId: ctx.botId,
        runId: ctx.runId,
        sink: ctx.sink,
        target: this.service.redactor.redactString(ctx.targetSummary, { runId: ctx.runId }).slice(0, 240),
        decision: 'denied',
      });
      throw new InteractionDenied(
        `使用保险库条目「${item.title}」需要人类确认，当前无可交互审批通道`,
        undefined,
        'user',
        false,
        'vault.denied',
      );
    }

    let decision: VaultApprovalDecision;
    try {
      decision = await this.approveUse(
        {
          botId: ctx.botId,
          runId: ctx.runId,
          itemId: item.id,
          itemTitle: item.title,
          category: item.category,
          fields,
          sink: ctx.sink,
          targetSummary: this.service.redactor.redactString(ctx.targetSummary, { runId: ctx.runId }).slice(0, 240),
          ...(bindingMismatch ? { bindingMismatch: true } : {}),
          ...(item.bindings.length ? { expectedBindings: item.bindings } : {}),
          allowRunGrant,
        },
        ctx.signal,
      );
    } catch (error) {
      if (errorCode(error) === 'vault.denied' || errorCode(error) === 'permission.denied') {
        this.service.recordAudit({
          action: 'denied',
          itemId: item.id,
          itemTitle: item.title,
          fields,
          botId: ctx.botId,
          runId: ctx.runId,
          sink: ctx.sink,
          target: this.service.redactor.redactString(ctx.targetSummary, { runId: ctx.runId }).slice(0, 240),
          decision: 'denied',
        });
      }
      throw error;
    }

    if (decision === 'deny') {
      this.service.recordAudit({
        action: 'denied',
        itemId: item.id,
        itemTitle: item.title,
        fields,
        botId: ctx.botId,
        runId: ctx.runId,
        sink: ctx.sink,
        target: this.service.redactor.redactString(ctx.targetSummary, { runId: ctx.runId }).slice(0, 240),
        decision: 'denied',
      });
      throw new InteractionDenied(`用户拒绝使用保险库条目「${item.title}」`, undefined, 'user', false, 'vault.denied');
    }

    if (decision === 'allow-run' && allowRunGrant) {
      let grants = this.runGrants.get(ctx.runId);
      if (!grants) {
        grants = new Set<string>();
        this.runGrants.set(ctx.runId, grants);
      }
      grants.add(runGrantKey);
      return 'user-run';
    }

    return 'user-once';
  }
}

/**
 * Materializes resolved `vaultFiles` into a private `0o700` host temp directory with `0o600` secret files
 * and optional one-shot `SSH_ASKPASS` script when a key has a companion passphrase.
 */
export function materializeHostVaultFiles(
  resolvedFiles: ResolvedVaultFile[],
  platform: NodeJS.Platform = process.platform,
): MaterializedHostVaultFiles {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-vault-'));
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Best-effort on platforms without POSIX modes. */
  }
  const env: Record<string, string> = {};
  const createdFiles: string[] = [];

  try {
    resolvedFiles.forEach((file, index) => {
      if (!ENV_VAR_RE.test(file.envVar)) {
        throw new AppError('vault.ref_invalid', `非法的环境变量名：${file.envVar}`);
      }
      const keyPath = join(dir, `key_${index}`);
      writeFileSync(keyPath, file.content, { mode: file.mode || 0o600 });
      try {
        chmodSync(keyPath, file.mode || 0o600);
      } catch {}
      createdFiles.push(keyPath);
      env[file.envVar] = keyPath;

      if (file.companionPassphrase !== undefined && !env.SSH_ASKPASS) {
        const passPath = join(dir, `pass_${index}`);
        writeFileSync(passPath, file.companionPassphrase, { mode: 0o600 });
        try {
          chmodSync(passPath, 0o600);
        } catch {}
        createdFiles.push(passPath);

        if (platform === 'win32') {
          const askpassPath = join(dir, `askpass_${index}.cmd`);
          writeFileSync(askpassPath, `@echo off\r\ntype "${passPath}"\r\n`, { mode: 0o700 });
          createdFiles.push(askpassPath);
          env.SSH_ASKPASS = askpassPath;
        } else {
          const askpassPath = join(dir, `askpass_${index}.sh`);
          const quoted = `'${passPath.replaceAll("'", "'\\''")}'`;
          writeFileSync(askpassPath, `#!/bin/sh\ncat ${quoted}\n`, { mode: 0o700 });
          try {
            chmodSync(askpassPath, 0o700);
          } catch {}
          createdFiles.push(askpassPath);
          env.SSH_ASKPASS = askpassPath;
        }
        env.SSH_ASKPASS_REQUIRE = 'force';
        env.DISPLAY = 'none';
      }
    });
  } catch (error) {
    cleanupFiles(dir, createdFiles);
    throw error;
  }

  return {
    dir,
    env,
    files: createdFiles,
    cleanup: () => cleanupFiles(dir, createdFiles),
  };
}

function cleanupFiles(dir: string, files: string[]): void {
  for (const file of files) {
    try {
      const size = statSync(file).size;
      if (size > 0) writeFileSync(file, Buffer.alloc(size));
    } catch {}
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** Builds the VM execution wrapper payload so `vaultEnv` / `vaultFiles` travel via stdin rather than shell cmdline. */
export function buildVmVaultPayload(
  resolvedFiles: ResolvedVaultFile[],
  resolvedEnv: Record<string, string> = {},
): VmVaultPayload {
  return {
    env: { ...resolvedEnv },
    files: resolvedFiles.map((file) => ({
      envVar: file.envVar,
      content: file.content,
      mode: file.mode,
      ...(file.companionPassphrase !== undefined ? { passphrase: file.companionPassphrase } : {}),
    })),
  };
}
