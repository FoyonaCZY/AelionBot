// Pure Vault placeholder parsing, slug normalization, masked previews, default policies and sink capability rules.
// Framework- and Node-free so main process, renderer and mobile share the exact same behavior.
import type { VaultAccessPolicy, VaultCategory, VaultFieldKind, VaultSink } from './types/vault-types';

/** Placeholder pattern: `{{vault:<itemIdOrSlug>.<fieldKey>}}`. */
export const VAULT_REF_RE = /\{\{vault:([a-z0-9][a-z0-9_-]{0,63})\.([a-zA-Z][a-zA-Z0-9_-]{0,47})\}\}/g;

const VAULT_REF_EXACT_RE = /^\{\{vault:([a-z0-9][a-z0-9_-]{0,63})\.([a-zA-Z][a-zA-Z0-9_-]{0,47})\}\}$/;
const VAULT_CANDIDATE_RE = /\{\{\s*vault\s*:[^}\r\n]*\}\}/gi;
const VAULT_PREFIX_RE = /\{\{\s*vault\s*:/i;
const VALID_FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;

export const RESERVED_VAULT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

export interface ParsedVaultRef {
  raw: string;
  item: string;
  field: string;
  start: number;
  end: number;
}

export function isValidVaultFieldKey(key: string): boolean {
  return VALID_FIELD_KEY_RE.test(key) && !RESERVED_VAULT_KEYS.has(key);
}

/** Parses an exact `{{vault:item.field}}` token, returning null when malformed or using reserved prototype keys. */
export function parseVaultRef(raw: string): { item: string; field: string } | null {
  const match = VAULT_REF_EXACT_RE.exec(raw);
  if (!match) return null;
  const [, item, field] = match;
  if (RESERVED_VAULT_KEYS.has(item) || RESERVED_VAULT_KEYS.has(field)) return null;
  return { item, field };
}

/** Extracts all valid `{{vault:item.field}}` references in order of appearance. */
export function extractVaultRefs(text: string): ParsedVaultRef[] {
  if (!text || !text.includes('{{vault:')) return [];
  const regex = new RegExp(VAULT_REF_RE.source, 'g');
  const refs: ParsedVaultRef[] = [];
  for (const match of text.matchAll(regex)) {
    const raw = match[0];
    const item = match[1];
    const field = match[2];
    if (RESERVED_VAULT_KEYS.has(item) || RESERVED_VAULT_KEYS.has(field)) continue;
    const start = match.index ?? 0;
    refs.push({ raw, item, field, start, end: start + raw.length });
  }
  return refs;
}

/** Returns any `{{vault:...}}` candidates in `text` that are malformed or reference reserved prototype keys. */
export function findInvalidVaultRefs(text: string): string[] {
  if (!text || !VAULT_PREFIX_RE.test(text)) return [];
  const invalid: string[] = [];
  const matchedRanges: Array<{ start: number; end: number }> = [];
  const candidateRe = new RegExp(VAULT_CANDIDATE_RE.source, 'gi');
  for (const match of text.matchAll(candidateRe)) {
    const raw = match[0];
    const start = match.index ?? 0;
    matchedRanges.push({ start, end: start + raw.length });
    if (!parseVaultRef(raw)) invalid.push(raw);
  }
  // Catch unclosed `{{vault:...` markers outside already-scanned `{{vault:...}}` spans.
  const prefixRe = new RegExp(VAULT_PREFIX_RE.source, 'gi');
  for (const match of text.matchAll(prefixRe)) {
    const start = match.index ?? 0;
    if (!matchedRanges.some((range) => start >= range.start && start < range.end)) {
      invalid.push(text.slice(start, start + 64));
    }
  }
  return invalid;
}

/** True when `text` contains at least one valid `{{vault:...}}` placeholder. */
export function containsVaultRef(text: string): boolean {
  return extractVaultRefs(text).length > 0;
}

/** True when `text` contains any valid or malformed `{{vault:...` marker (used by hard-block guards). */
export function containsVaultMarker(text: string): boolean {
  return Boolean(text) && (containsVaultRef(text) || findInvalidVaultRefs(text).length > 0);
}

/** Normalizes any title or slug into a safe `[a-z0-9][a-z0-9_-]{0,63}` identifier. */
export function normalizeSlug(raw: string, fallback = 'item'): string {
  const clean = (input: string) =>
    input
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 64)
      .replace(/[-_]+$/g, '');

  let slug = clean(raw);
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = clean(fallback) || 'item';
  if (RESERVED_VAULT_KEYS.has(slug)) slug = `${slug.slice(0, 59)}-item`;
  return slug;
}

export const CATEGORY_DEFAULT_POLICY: Readonly<Record<VaultCategory, VaultAccessPolicy>> = {
  login: 'ask-once-per-run',
  contact: 'auto',
  card: 'always-ask',
  ssh_key: 'ask-once-per-run',
  api_key: 'ask-once-per-run',
  secret: 'ask-once-per-run',
};

export const CATEGORY_DEFAULT_SINKS: Readonly<Record<VaultCategory, readonly VaultSink[]>> = {
  login: ['vm_desktop', 'host_desktop', 'exec_env', 'exec_inline', 'mcp'],
  contact: ['vm_desktop', 'host_desktop', 'exec_env', 'exec_inline', 'python_env', 'mcp'],
  card: ['vm_desktop', 'host_desktop'],
  ssh_key: ['exec_file', 'exec_env', 'vm_desktop', 'host_desktop'],
  api_key: ['exec_env', 'python_env', 'exec_inline', 'mcp', 'vm_desktop', 'host_desktop'],
  secret: ['vm_desktop', 'host_desktop', 'exec_env', 'python_env', 'mcp'],
};

const HARD_BLOCKED_TOOLS = new Set([
  'file_write',
  'file_patch',
  'host_file_write',
  'host_file_patch',
  'apply_patch',
  'memory',
  'skill_save',
  'skill_patch',
  'skill_file_write',
  'web_read',
  'bot_send_message',
  'group_send_message',
  'open_preview',
  'preview_mark',
  'widget_save',
  'automation_create',
  'automation_update',
  'request_user_input',
  'request_user_control',
]);

const SINK_ALLOWED_TOOLS = new Set([
  'computer',
  'host_computer',
  'exec_command',
  'write_stdin',
  'python_execute',
  'python_session',
  'mcp_call',
  'code_exec',
]);

/** Tools prohibited from receiving any `{{vault:...}}` reference. */
export function isHardBlockedTool(toolName: string): boolean {
  if (HARD_BLOCKED_TOOLS.has(toolName)) return true;
  if (toolName.startsWith('mcp__')) return false;
  return !SINK_ALLOWED_TOOLS.has(toolName);
}

/** Hard system boundaries that item-level configuration (`allowedSinks`) can never override. */
export function isHardBlockedSink(
  category: VaultCategory,
  fieldKind: VaultFieldKind,
  sink: VaultSink,
  fieldKey?: string,
): boolean {
  if (category === 'card') {
    return sink !== 'vm_desktop' && sink !== 'host_desktop';
  }
  if (category === 'ssh_key' && fieldKey === 'privateKey') {
    return sink !== 'exec_file';
  }
  if (fieldKind === 'multiline_key') {
    if (category === 'ssh_key') return sink !== 'exec_file';
    return sink === 'exec_inline' || sink === 'mcp' || sink === 'python_env';
  }
  if (fieldKind === 'card_number' || fieldKind === 'cvv') {
    return sink !== 'vm_desktop' && sink !== 'host_desktop';
  }
  return false;
}

/** Computes effective sinks for a specific field after intersecting with hard security invariants. */
export function allowedSinksForField(
  category: VaultCategory,
  fieldKind: VaultFieldKind,
  itemAllowedSinks?: readonly VaultSink[],
  fieldKey?: string,
): VaultSink[] {
  const hasExplicit = Boolean(itemAllowedSinks && itemAllowedSinks.length > 0);
  const base = hasExplicit ? itemAllowedSinks! : CATEGORY_DEFAULT_SINKS[category];
  const filtered = base.filter((sink) => !isHardBlockedSink(category, fieldKind, sink, fieldKey));
  if (
    !hasExplicit &&
    fieldKind === 'multiline_key' &&
    !filtered.includes('exec_file') &&
    !isHardBlockedSink(category, fieldKind, 'exec_file', fieldKey)
  ) {
    return [...filtered, 'exec_file'];
  }
  return filtered;
}

const PASSWORD_KEYS = new Set([
  'password',
  'passwd',
  'pass',
  'passphrase',
  'secret',
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'recoverycodes',
  'recovery_codes',
  'bearer',
  'clientsecret',
  'client_secret',
]);

const CVV_KEYS = new Set(['cvv', 'cvc', 'cvv2', 'cid', 'pin', 'securitycode', 'security_code']);

/** Infers redaction kind from field key, item category, and optional value shape. */
export function inferFieldKind(key: string, category?: VaultCategory, value?: string): VaultFieldKind {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const compact = normalized.replace(/_/g, '');

  if (compact === 'totpsecret' || compact === 'otpsecret' || compact === 'totp') return 'totp';
  if (compact === 'cardnumber' || compact === 'ccnumber' || (category === 'card' && compact === 'number')) {
    return 'card_number';
  }
  if (CVV_KEYS.has(normalized) || CVV_KEYS.has(compact)) return 'cvv';
  if (
    compact === 'privatekey' ||
    compact === 'sshprivatekey' ||
    compact === 'pem' ||
    (value && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value))
  ) {
    return 'multiline_key';
  }
  if (compact === 'email' || compact === 'mail') return 'email';
  if (compact === 'phone' || compact === 'mobile' || compact === 'tel' || compact === 'telephone') return 'phone';
  if (PASSWORD_KEYS.has(normalized) || PASSWORD_KEYS.has(compact)) return 'password';
  if (category === 'api_key' && (compact === 'key' || compact === 'value')) return 'password';
  if (category === 'secret' && compact === 'value') return 'password';
  return 'text';
}

// Pure-TS SHA-256 over UTF-8 bytes so `maskPreview` works in browser/mobile without Node crypto.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
}

function maskText(trimmed: string): string {
  const chars = Array.from(trimmed);
  if (chars.length <= 4) return '••••';
  return `${chars.slice(0, 2).join('')}***`;
}

/**
 * Produces a safe masked preview for any field kind without ever exposing the raw secret.
 * Follows Section 3.5 masking rules.
 */
export function maskPreview(value: string, kind: VaultFieldKind): string {
  const trimmed = value.trim();
  if (!trimmed) return '••••';

  switch (kind) {
    case 'password':
    case 'cvv':
    case 'totp':
      return '••••••';
    case 'email': {
      const at = trimmed.lastIndexOf('@');
      if (at <= 0 || at >= trimmed.length - 1 || /\s/.test(trimmed)) {
        return maskText(trimmed);
      }
      const local = Array.from(trimmed.slice(0, at));
      const domain = trimmed.slice(at + 1);
      if (local.length <= 2) return `***@${domain}`;
      return `${local[0]}***@${domain}`;
    }
    case 'phone': {
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length < 6) return '••••';
      return `***-****-${digits.slice(-4)}`;
    }
    case 'card_number': {
      const digits = trimmed.replace(/[\s-]+/g, '');
      if (digits.length < 8) return '••••';
      return `•••• ${digits.slice(-4)}`;
    }
    case 'multiline_key': {
      const hash = sha256Hex(trimmed);
      const label = /PRIVATE KEY|ssh-(?:rsa|ed25519|ecdsa)|ecdsa-sha2/i.test(trimmed) ? 'SSH Key' : 'Key';
      return `${label} (SHA256:${hash.slice(0, 4)}…${hash.slice(-2)})`;
    }
    case 'text':
    default:
      return maskText(trimmed);
  }
}
