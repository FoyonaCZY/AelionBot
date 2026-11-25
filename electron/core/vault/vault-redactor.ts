// Deep string, value and error redactor for Vault secrets.
// Normal secrets (>= 6 chars) generate encoded/card/PEM variants; short secrets (3-5 chars) NEVER do global replace
// and are only scrubbed in targeted control-value / CVV / PIN contexts scoped to the runId that resolved them.
import { AppError } from '../../../shared/errors';
import { RESERVED_VAULT_KEYS } from '../../../shared/vault-refs';
import type { VaultFieldKind } from '../../../shared/types/vault-types';

export const VAULT_REDACTION_MARKER = '[redacted:vault]';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TARGETED_KEY_RE = /^(?:cvv|cvc|cvv2|cid|pin|passcode|security_?code|otp|totp|安全码|校验码|验证码)$/i;
const VALUE_KEY_RE = /^(?:value|text)$/i;

function expandNormalVariants(raw: string, kind?: VaultFieldKind): string[] {
  const variants = new Set<string>();
  const add = (candidate: string) => {
    if (candidate.length >= 6) variants.add(candidate);
  };
  const addEncoded = (base: string) => {
    add(base);
    try {
      const encoded = encodeURIComponent(base);
      add(encoded);
      add(encoded.replace(/%20/g, '+'));
    } catch {
      /* Ignore lone surrogates. */
    }
    add(JSON.stringify(base).slice(1, -1));
    add(Buffer.from(base, 'utf8').toString('base64'));
    add(Buffer.from(base, 'utf8').toString('base64url'));
  };

  const trimmed = raw.trim();
  if (trimmed.length < 6) return [];

  for (const base of new Set([raw, trimmed])) {
    addEncoded(base);
  }

  if (kind === 'card_number') {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 6) {
      add(digits);
      add(digits.replace(/(.{4})(?=.)/g, '$1 '));
      add(digits.replace(/(.{4})(?=.)/g, '$1-'));
      if (digits.length === 15) {
        add(`${digits.slice(0, 4)} ${digits.slice(4, 10)} ${digits.slice(10)}`);
        add(`${digits.slice(0, 4)}-${digits.slice(4, 10)}-${digits.slice(10)}`);
      }
    }
  }

  if (kind === 'multiline_key' || raw.includes('\n')) {
    const lf = raw.replace(/\r\n/g, '\n');
    const lfTrailing = lf.endsWith('\n') ? lf : lf + '\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    for (const block of new Set([lf, lf.trim(), lfTrailing, crlf, crlf.trim()])) {
      addEncoded(block);
    }
    for (const line of lf.split('\n')) {
      const cleanLine = line.trim();
      if (cleanLine.startsWith('-----BEGIN ') || cleanLine.startsWith('-----END ')) continue;
      if (cleanLine.length >= 16) addEncoded(cleanLine);
    }
  }

  return [...variants];
}

export class VaultRedactor {
  private itemNormals = new Map<string, string[]>();
  private runNormals = new Map<string, Set<string>>();
  private adHocNormals = new Set<string>();
  private runShortSecrets = new Map<string, Set<string>>();
  private cachedVariants?: string[];
  private cachedRegex?: RegExp | null;

  private invalidate(): void {
    this.cachedVariants = undefined;
    this.cachedRegex = undefined;
  }

  private compiled(): { variants: string[]; regex: RegExp | null } {
    if (this.cachedVariants !== undefined && this.cachedRegex !== undefined) {
      return { variants: this.cachedVariants, regex: this.cachedRegex };
    }
    const all = new Set<string>(this.adHocNormals);
    for (const list of this.itemNormals.values()) {
      for (const variant of list) all.add(variant);
    }
    for (const set of this.runNormals.values()) {
      for (const variant of set) all.add(variant);
    }
    const variants = [...all].sort((a, b) => b.length - a.length);
    const regex = variants.length ? new RegExp(variants.map(escapeRegExp).join('|'), 'g') : null;
    this.cachedVariants = variants;
    this.cachedRegex = regex;
    return { variants, regex };
  }

  /** Registers one secret value (`itemNormals` for `itemId`, `runNormals`/`runShortSecrets` for `runId`, else `adHocNormals`). */
  register(value: string, options: { kind?: VaultFieldKind; itemId?: string; runId?: string } = {}): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= 6) {
      const variants = expandNormalVariants(value, options.kind);
      if (options.itemId) {
        const existing = this.itemNormals.get(options.itemId) || [];
        this.itemNormals.set(options.itemId, [...new Set([...existing, ...variants])]);
      } else if (options.runId) {
        let set = this.runNormals.get(options.runId);
        if (!set) {
          set = new Set<string>();
          this.runNormals.set(options.runId, set);
        }
        for (const variant of variants) set.add(variant);
      } else {
        for (const variant of variants) this.adHocNormals.add(variant);
      }
      this.invalidate();
      return;
    }
    if (options.runId && trimmed.length >= 3 && trimmed.length <= 5) {
      this.recordRunSecret(options.runId, value, options.kind);
    }
  }

  /** Replaces all normal-length secret variants tracked for a specific item ID. */
  setForItem(itemId: string, fields: Array<{ value: string; kind?: VaultFieldKind }>): void {
    const variants: string[] = [];
    for (const field of fields) {
      if (typeof field.value !== 'string') continue;
      if (field.value.trim().length >= 6) {
        variants.push(...expandNormalVariants(field.value, field.kind));
      }
    }
    if (variants.length) this.itemNormals.set(itemId, [...new Set(variants)]);
    else this.itemNormals.delete(itemId);
    this.invalidate();
  }

  removeItem(itemId: string): void {
    if (this.itemNormals.delete(itemId)) this.invalidate();
  }

  /**
   * Records a resolved secret for `runId`:
   * - Short secrets (3-5 chars) are scoped strictly to `runId` targeted contexts;
   * - Normal secrets (>= 6 chars) without `itemId` (e.g. ephemeral TOTP codes) go into `runNormals` and are evicted on `clearRun(runId)`.
   */
  recordRunSecret(runId: string, value: string, kind?: VaultFieldKind, options?: { itemId?: string }): void {
    if (!runId || typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= 6) {
      if (options?.itemId && this.itemNormals.has(options.itemId)) return;
      this.register(value, { kind, ...(options?.itemId ? { itemId: options.itemId } : { runId }) });
      return;
    }
    if (trimmed.length >= 3 && trimmed.length <= 5) {
      let set = this.runShortSecrets.get(runId);
      if (!set) {
        set = new Set<string>();
        this.runShortSecrets.set(runId, set);
      }
      set.add(trimmed);
      if (value.length >= 3 && value.length <= 5) set.add(value);
    }
  }

  clearRun(runId: string): void {
    this.runShortSecrets.delete(runId);
    if (this.runNormals.delete(runId)) this.invalidate();
  }

  /** Returns all active normal secret variants (>= 6 chars) sorted longest-first. Never emits 3-5 char short values. */
  activeValues(): string[] {
    return [...this.compiled().variants];
  }

  private redactShortInText(text: string, runId: string): string {
    const shorts = this.runShortSecrets.get(runId);
    if (!shorts?.size) return text;
    let out = text;
    const sorted = [...shorts].sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
      const escaped = escapeRegExp(secret);
      // 1. Accessibility / HTML control value attribute: value="412" / value='412'
      out = out.replace(new RegExp(`(\\bvalue\\s*=\\s*["'])${escaped}(["'])`, 'gi'), `$1${VAULT_REDACTION_MARKER}$2`);
      // 2. Host accessibility tree format (`desktop-helper-mac.swift` & `desktop-helper-source.ts`):
      //    e.g. `12 Edit "安全码" = "412" [x,y wxh]` or `12 Edit = "412" [x,y wxh]`
      out = out.replace(new RegExp(`(\\s=\\s")${escaped}(")`, 'g'), `$1${VAULT_REDACTION_MARKER}$2`);
      // 3. JSON or key=value pairs: "cvv":"412", pin=8392, "安全码":"412"
      out = out.replace(
        new RegExp(
          `(["']?(?:value|cvv|cvc|cvv2|cid|pin|passcode|security[_ ]?code|otp|totp|code|安全码|校验码|验证码)["']?\\s*[:=]\\s*["']?)${escaped}(["']?(?=[\\s,}\\];)]|$))`,
          'gi',
        ),
        `$1${VAULT_REDACTION_MARKER}$2`,
      );
      // 4. Explicit label prose (ASCII & CJK labels): "CVV is 412", "PIN: 8392", "安全码 412"
      out = out.replace(
        new RegExp(
          `((?:^|[\\s,;:{\\["'(])(?:cvv|cvc|cvv2|cid|pin|passcode|security\\s+code|otp|totp|安全码|校验码|验证码)(?:\\s+(?:is|code|为|是))?\\s*[:=]?\\s*)${escaped}(?=\\s|$|[^a-zA-Z0-9_])`,
          'gi',
        ),
        `$1${VAULT_REDACTION_MARKER}`,
      );
    }
    return out;
  }

  redactString(text: string, options: { runId?: string } = {}): string {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    const { regex } = this.compiled();
    if (regex) {
      out = out.replace(regex, VAULT_REDACTION_MARKER);
    }
    if (options.runId) {
      out = this.redactShortInText(out, options.runId);
    }
    return out;
  }

  redactError(error: unknown, options: { runId?: string } = {}): Error {
    return this.redactErrorInternal(error, options, new WeakMap());
  }

  private redactErrorInternal(error: unknown, options: { runId?: string }, seen: WeakMap<object, unknown>): Error {
    if (!(error instanceof Error)) {
      return new Error(this.redactString(String(error), options));
    }
    const existing = seen.get(error);
    if (existing instanceof Error) return existing;

    const clone = Object.create(Object.getPrototypeOf(error)) as Error & Record<string, unknown>;
    seen.set(error, clone);

    const message = this.redactString(error.message, options);
    Object.defineProperty(clone, 'message', { value: message, writable: true, enumerable: false, configurable: true });
    if (typeof error.name === 'string') {
      Object.defineProperty(clone, 'name', {
        value: error.name,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (typeof error.stack === 'string') {
      Object.defineProperty(clone, 'stack', {
        value: this.redactString(error.stack, options),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    for (const key of Object.keys(error)) {
      if (RESERVED_VAULT_KEYS.has(key)) continue;
      const value = (error as unknown as Record<string, unknown>)[key];
      if (key === 'code' && error instanceof AppError) {
        clone[key] = value;
      } else {
        clone[key] = this.redactInternal(value, options, seen);
      }
    }
    if ('cause' in error && error.cause !== undefined && !Object.prototype.propertyIsEnumerable.call(error, 'cause')) {
      Object.defineProperty(clone, 'cause', {
        value: this.redactInternal(error.cause, options, seen),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    return clone;
  }

  redactValue<T>(value: T, options: { runId?: string } = {}): T {
    return this.redactInternal(value, options, new WeakMap()) as T;
  }

  private redactInternal(value: unknown, options: { runId?: string }, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === 'string') return this.redactString(value, options);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Error) return this.redactErrorInternal(value, options, seen);
    if (ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp) return value;

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      for (const item of value) out.push(this.redactInternal(item, options, seen));
      return out;
    }

    const out: Record<string, unknown> = {};
    seen.set(value, out);
    const shortSecrets = options.runId ? this.runShortSecrets.get(options.runId) : undefined;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (RESERVED_VAULT_KEYS.has(key)) continue;
      const safeKey = this.redactString(key, options);
      if (RESERVED_VAULT_KEYS.has(safeKey)) continue;
      if (typeof item === 'string' && shortSecrets?.size) {
        const trimmed = item.trim();
        if (shortSecrets.has(trimmed) && (TARGETED_KEY_RE.test(key) || VALUE_KEY_RE.test(key))) {
          out[safeKey] = VAULT_REDACTION_MARKER;
          continue;
        }
      }
      out[safeKey] = this.redactInternal(item, options, seen);
    }
    return out;
  }
}
