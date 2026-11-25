// Shared Vault types across main process, renderer, preload and mobile. Never carries plaintext secrets in metadata.

export const VAULT_CATEGORIES = ['login', 'contact', 'card', 'ssh_key', 'api_key', 'secret'] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

export const VAULT_ACCESS_POLICIES = ['auto', 'auto-when-bound', 'ask-once-per-run', 'always-ask'] as const;
export type VaultAccessPolicy = (typeof VAULT_ACCESS_POLICIES)[number];

export const VAULT_SINKS = [
  'vm_desktop',
  'host_desktop',
  'exec_env',
  'exec_file',
  'exec_inline',
  'python_env',
  'mcp',
] as const;
export type VaultSink = (typeof VAULT_SINKS)[number];

/** Affects redaction and scrubbing strength; all fields are blind-injected and hidden from the model by default. */
export type VaultFieldKind = 'text' | 'email' | 'phone' | 'password' | 'card_number' | 'cvv' | 'totp' | 'multiline_key';

export interface VaultFieldMeta {
  /** Field key, e.g. username, password, cardNumber, privateKey. */
  key: string;
  /** Optional display label. */
  label?: string;
  kind: VaultFieldKind;
  /** Masked preview that never reconstructs raw plaintext, e.g. "z***@example.com", "•••• 4242", "••••••". */
  preview: string;
  /** True when the underlying secret has length < 6 (such as a 3-4 digit CVV/PIN); redactor avoids global replace. */
  shortValue?: boolean;
  /** True for derived virtual fields such as `totp` computed from `totpSecret`. */
  derived?: boolean;
}

export interface VaultBinding {
  kind: 'domain' | 'host' | 'app' | 'mcp';
  value: string;
}

/** Pure metadata visible to the renderer and the model directory (never contains ciphertext or plaintext). */
export interface VaultItemMeta {
  id: string;
  /** Globally unique readable slug (lowercase letters, digits, underscores, hyphens), e.g. "github-personal". */
  slug: string;
  category: VaultCategory;
  title: string;
  /** Short non-sensitive note helping the model choose the right item. */
  notes?: string;
  tags: string[];
  bindings: VaultBinding[];
  fields: VaultFieldMeta[];
  policy: VaultAccessPolicy;
  /** Optional override for allowed sinks (cannot bypass hard-blocked system invariants). */
  allowedSinks?: VaultSink[];
  /** Empty or undefined means available to all Bots; otherwise restricted to listed Bot IDs. */
  botIds?: string[];
  /** Whether unattended use in scheduledRun is permitted; forced false for `card`. */
  allowInAutomation?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  /** True when restored from another machine without backup password and decryption fails. */
  unreadable?: boolean;
}

export interface VaultItemWriteInput {
  id?: string;
  slug?: string;
  category: VaultCategory;
  title: string;
  notes?: string;
  tags?: string[];
  bindings?: VaultBinding[];
  /** Plaintext field values; when updating, omit unchanged fields and pass null to delete a field. */
  fields: Record<string, string | null>;
  fieldKinds?: Record<string, VaultFieldKind>;
  /** Optional ephemeral import tokens from `vaultImportSshKey` mapped by field key (e.g. `{ privateKey: token }`). */
  importTokens?: Record<string, string>;
  policy?: VaultAccessPolicy;
  allowedSinks?: VaultSink[];
  botIds?: string[];
  allowInAutomation?: boolean;
}

export interface VaultAuditEntry {
  id: string;
  time: string;
  action: 'save' | 'update' | 'delete' | 'use' | 'denied' | 'reveal';
  itemId: string;
  itemTitle: string;
  fields: string[];
  botId?: string;
  runId?: string;
  sink?: VaultSink;
  /** Redacted target summary (tool/window/domain/command), never containing plaintext. */
  target?: string;
  decision?: 'auto' | 'user-once' | 'user-run' | 'denied';
}

export interface VaultOverview {
  available: boolean;
  items: VaultItemMeta[];
}

export interface VaultInputFieldSpec {
  key: string;
  label: string;
  kind: VaultFieldKind;
  required?: boolean;
  placeholder?: string;
}

export interface VaultInputInteraction {
  id: string;
  botId: string;
  runId: string;
  createdAt: string;
  kind: 'vault_input';
  phase: 'waiting';
  title: string;
  reason: string;
  category: VaultCategory;
  suggestedSlug?: string;
  bindings?: VaultBinding[];
  fields: VaultInputFieldSpec[];
  existingItemId?: string;
}

export interface VaultUseInteraction {
  id: string;
  botId: string;
  runId: string;
  createdAt: string;
  kind: 'vault_use';
  phase: 'waiting';
  itemId: string;
  itemTitle: string;
  category: VaultCategory;
  fields: string[];
  sink: VaultSink;
  targetSummary: string;
  bindingMismatch?: boolean;
  expectedBindings?: VaultBinding[];
  allowRunGrant: boolean;
}

export interface VaultSshImportResult {
  token: string;
  fileName: string;
  fingerprint: string;
  preview: string;
  publicKey?: string;
  encrypted?: boolean;
}
