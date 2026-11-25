import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Bot } from '../../shared/types/core';
import {
  VAULT_ACCESS_POLICIES,
  VAULT_CATEGORIES,
  type VaultAccessPolicy,
  type VaultAuditEntry,
  type VaultBinding,
  type VaultCategory,
  type VaultFieldKind,
  type VaultItemMeta,
  type VaultItemWriteInput,
  type VaultOverview,
  type VaultSshImportResult,
} from '../../shared/types/vault-types';
import { CATEGORY_DEFAULT_POLICY, isValidVaultFieldKey, normalizeSlug } from '../../shared/vault-refs';
import {
  VAULT_BINDING_LABELS,
  VAULT_CATEGORY_LABELS,
  VAULT_POLICY_LABELS,
  VAULT_SINK_LABELS,
} from '../../shared/chat/activity';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { Presence } from '../ui/Presence';
import { Select } from '../ui/Select';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import { SettingsEmpty, SettingsSection } from './SettingsWindow';
import './vault-settings.css';

interface FieldPreset {
  key: string;
  label: string;
  kind: VaultFieldKind;
  placeholder?: string;
}

const CATEGORY_PRESETS: Record<VaultCategory, readonly FieldPreset[]> = {
  login: [
    { key: 'username', label: '用户名', kind: 'text', placeholder: 'alice' },
    { key: 'email', label: '邮箱', kind: 'email', placeholder: 'name@example.com' },
    { key: 'password', label: '密码', kind: 'password' },
    { key: 'totpSecret', label: '两步验证密钥 (TOTP)', kind: 'totp', placeholder: 'Base32' },
    { key: 'recoveryCodes', label: '备用恢复码', kind: 'password' },
  ],
  contact: [
    { key: 'fullName', label: '姓名', kind: 'text' },
    { key: 'email', label: '邮箱', kind: 'email' },
    { key: 'phone', label: '手机号', kind: 'phone' },
    { key: 'addressLine1', label: '详细地址 1', kind: 'text' },
    { key: 'addressLine2', label: '详细地址 2', kind: 'text' },
    { key: 'city', label: '城市', kind: 'text' },
    { key: 'state', label: '省 / 州', kind: 'text' },
    { key: 'postalCode', label: '邮政编码', kind: 'text' },
    { key: 'country', label: '国家 / 地区', kind: 'text' },
    { key: 'company', label: '公司 / 组织', kind: 'text' },
  ],
  card: [
    { key: 'cardholderName', label: '持卡人姓名', kind: 'text' },
    { key: 'cardNumber', label: '卡号', kind: 'card_number' },
    { key: 'expMonth', label: '到期月', kind: 'text', placeholder: 'MM' },
    { key: 'expYear', label: '到期年', kind: 'text', placeholder: 'YYYY' },
    { key: 'expiry', label: '有效期', kind: 'text', placeholder: 'MM/YY' },
    { key: 'cvv', label: '安全码 (CVV)', kind: 'cvv' },
    { key: 'billingAddress', label: '账单地址', kind: 'text' },
    { key: 'billingPostalCode', label: '账单邮编', kind: 'text' },
  ],
  ssh_key: [
    { key: 'privateKey', label: '私钥', kind: 'multiline_key' },
    { key: 'passphrase', label: '私钥口令', kind: 'password' },
    { key: 'publicKey', label: '公钥', kind: 'text' },
    { key: 'username', label: '用户名', kind: 'text', placeholder: 'git / root' },
    { key: 'host', label: '主机地址', kind: 'text', placeholder: 'github.com' },
    { key: 'port', label: '端口', kind: 'text', placeholder: '22' },
  ],
  api_key: [
    { key: 'apiKey', label: 'API Key', kind: 'password' },
    { key: 'apiSecret', label: 'API Secret', kind: 'password' },
    { key: 'baseUrl', label: '接口地址', kind: 'text', placeholder: 'https://api.example.com' },
    { key: 'orgId', label: '组织 ID', kind: 'text' },
    { key: 'headerName', label: '请求头名称', kind: 'text', placeholder: 'Authorization' },
  ],
  secret: [{ key: 'value', label: '机密值', kind: 'password' }],
};

const FIELD_LABEL_BY_KEY: Record<string, string> = Object.values(CATEGORY_PRESETS)
  .flat()
  .reduce<Record<string, string>>((acc, item) => {
    if (!acc[item.key]) acc[item.key] = item.label;
    return acc;
  }, {});

const FIELD_KIND_LABELS: Record<VaultFieldKind, string> = {
  text: '文本',
  email: '邮箱',
  phone: '电话',
  password: '密码 / 密钥',
  card_number: '银行卡号',
  cvv: '安全码',
  totp: 'TOTP 密钥',
  multiline_key: '多行私钥',
};

const AUDIT_ACTION_LABELS: Record<VaultAuditEntry['action'], string> = {
  save: '新增',
  update: '更新',
  delete: '删除',
  use: '使用',
  denied: '已拒绝',
  reveal: '查看明文',
};

const AUDIT_DECISION_LABELS: Record<NonNullable<VaultAuditEntry['decision']>, string> = {
  auto: '自动放行',
  'user-once': '本次允许',
  'user-run': '任务内允许',
  denied: '已拒绝',
};

const REVEAL_TTL_SECONDS = 30;
const BINDING_KINDS: ReadonlyArray<VaultBinding['kind']> = ['domain', 'host', 'app', 'mcp'];
const FIELD_KINDS: ReadonlyArray<VaultFieldKind> = [
  'text',
  'password',
  'email',
  'phone',
  'card_number',
  'cvv',
  'totp',
  'multiline_key',
];

interface EditorFieldRow {
  key: string;
  label?: string;
  kind: VaultFieldKind;
  placeholder?: string;
  existingPreview?: string;
  isCustom?: boolean;
}

interface EditorState {
  existing?: VaultItemMeta;
  category: VaultCategory;
  title: string;
  slug: string;
  notes: string;
  tagsText: string;
  rows: EditorFieldRow[];
  values: Record<string, string>;
  deletedKeys: string[];
  importTokens: Record<string, string>;
  sshImport?: VaultSshImportResult;
  bindings: VaultBinding[];
  policy: VaultAccessPolicy;
  botIds?: string[];
  allowInAutomation: boolean;
}

function buildRowsForCategory(category: VaultCategory, existing?: VaultItemMeta): EditorFieldRow[] {
  const presets = CATEGORY_PRESETS[category];
  const presetMap = new Map(presets.map((p) => [p.key, p]));
  const existingMap = new Map((existing?.fields || []).filter((f) => !f.derived).map((f) => [f.key, f]));
  const rows: EditorFieldRow[] = [];

  for (const preset of presets) {
    const match = existingMap.get(preset.key);
    rows.push({
      key: preset.key,
      label: match?.label || preset.label,
      kind: match?.kind || preset.kind,
      placeholder: preset.placeholder,
      ...(match ? { existingPreview: match.preview } : {}),
    });
  }
  for (const field of existing?.fields || []) {
    if (field.derived || presetMap.has(field.key)) continue;
    rows.push({
      key: field.key,
      label: field.label || FIELD_LABEL_BY_KEY[field.key],
      kind: field.kind,
      existingPreview: field.preview,
      isCustom: true,
    });
  }
  return rows;
}

function createEditorState(item?: VaultItemMeta): EditorState {
  const category = item?.category || 'login';
  return {
    existing: item,
    category,
    title: item?.title || '',
    slug: item?.slug || '',
    notes: item?.notes || '',
    tagsText: item?.tags.join(', ') || '',
    rows: buildRowsForCategory(category, item),
    values: {},
    deletedKeys: [],
    importTokens: {},
    bindings: item?.bindings.map((b) => ({ ...b })) || [],
    policy: item?.policy || CATEGORY_DEFAULT_POLICY[category],
    botIds: item?.botIds?.length ? [...item.botIds] : undefined,
    allowInAutomation: category === 'card' ? false : Boolean(item?.allowInAutomation),
  };
}

function isSensitiveFieldKind(kind: VaultFieldKind) {
  return kind === 'password' || kind === 'card_number' || kind === 'cvv' || kind === 'totp' || kind === 'multiline_key';
}

function VaultItemDialog({
  editor,
  bots,
  available,
  onClose,
  onSaved,
  onNotify,
}: {
  editor: EditorState;
  bots: Bot[];
  available: boolean;
  onClose: () => void;
  onSaved: (saved: VaultItemMeta) => void;
  onNotify: (message: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<EditorState>(editor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copiedKey, setCopiedKey] = useState('');
  const [showInputPlain, setShowInputPlain] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null);
  const [revealSeconds, setRevealSeconds] = useState(0);
  const [customKey, setCustomKey] = useState('');
  const [customKind, setCustomKind] = useState<VaultFieldKind>('text');
  const [customValue, setCustomValue] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);
  const revealedTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const revealEpochRef = useRef(0);

  const clearRevealed = useCallback(() => {
    revealEpochRef.current += 1;
    clearInterval(revealedTimer.current);
    revealedTimer.current = undefined;
    setRevealed(null);
    setRevealSeconds(0);
  }, []);

  const clearSensitiveAndClose = useCallback(() => {
    clearRevealed();
    setShowInputPlain({});
    setDraft((prev) => ({ ...prev, values: {}, importTokens: {}, sshImport: undefined }));
    setAddingCustom(false);
    setCustomKey('');
    setCustomKind('text');
    setCustomValue('');
    onClose();
  }, [clearRevealed, onClose]);

  useEffect(() => {
    setDraft(editor);
    setBusy(false);
    setError('');
    setShowInputPlain({});
    clearRevealed();
    setAddingCustom(false);
    setCustomKey('');
    setCustomKind('text');
    setCustomValue('');
  }, [editor, clearRevealed]);

  // Clear any revealed plaintext and re-mask input eyes on unmount, window blur, tab hide, or Escape.
  useEffect(() => {
    const onBlur = () => {
      clearRevealed();
      setShowInputPlain({});
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        clearRevealed();
        setShowInputPlain({});
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearSensitiveAndClose();
      }
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKeyDown, true);
      clearRevealed();
    };
  }, [clearRevealed, clearSensitiveAndClose]);

  useEffect(() => {
    if (!copiedKey) return;
    const timer = setTimeout(() => setCopiedKey(''), 1800);
    return () => clearTimeout(timer);
  }, [copiedKey]);

  const handleCategoryChange = (nextCategory: VaultCategory) => {
    const nextRows = buildRowsForCategory(nextCategory, draft.existing);
    const keepKeys = new Set(nextRows.map((row) => row.key));
    const nextValues: Record<string, string> = {};
    for (const [key, val] of Object.entries(draft.values)) {
      if (keepKeys.has(key) || draft.rows.some((r) => r.key === key && r.isCustom)) {
        nextValues[key] = val;
      }
    }
    const customRows = draft.rows.filter((r) => r.isCustom && !keepKeys.has(r.key));
    setDraft({
      ...draft,
      category: nextCategory,
      rows: [...nextRows, ...customRows],
      values: nextValues,
      policy: nextCategory === 'card' ? 'always-ask' : CATEGORY_DEFAULT_POLICY[nextCategory],
      allowInAutomation: nextCategory === 'card' ? false : draft.allowInAutomation,
    });
  };

  const revealPlaintext = async () => {
    if (!draft.existing || busy || !available) return;
    const epoch = revealEpochRef.current;
    setBusy(true);
    setError('');
    try {
      const fields = await window.aelion.vaultReveal(draft.existing.id);
      if (revealEpochRef.current !== epoch) return;
      clearInterval(revealedTimer.current);
      setRevealed(fields);
      setRevealSeconds(REVEAL_TTL_SECONDS);
      const deadline = Date.now() + REVEAL_TTL_SECONDS * 1000;
      revealedTimer.current = setInterval(() => {
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        if (remaining <= 0) {
          clearRevealed();
        } else {
          setRevealSeconds(remaining);
        }
      }, 1000);
    } catch (err) {
      if (revealEpochRef.current === epoch) setError(ipcErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const importSshKey = async () => {
    if (busy || !available) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.aelion.vaultImportSshKey();
      if (!result) return;
      setDraft((prev) => {
        const nextValues = { ...prev.values };
        delete nextValues.privateKey;
        if (result.publicKey && !nextValues.publicKey) {
          nextValues.publicKey = result.publicKey;
        }
        return {
          ...prev,
          title: prev.title.trim() ? prev.title : result.fileName,
          values: nextValues,
          deletedKeys: prev.deletedKeys.filter((k) => k !== 'privateKey'),
          importTokens: { ...prev.importTokens, privateKey: result.token },
          sshImport: result,
        };
      });
    } catch (err) {
      setError(ipcErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const addCustomField = () => {
    const trimmedKey = customKey.trim();
    if (!trimmedKey || !isValidVaultFieldKey(trimmedKey) || trimmedKey === 'totp') {
      setError(t('字段名需以字母开头，仅含字母、数字、下划线或连字符（不能为 totp）'));
      return;
    }
    if (draft.rows.some((row) => row.key === trimmedKey)) {
      setError(t('已存在同名字段「{key}」', { key: trimmedKey }));
      return;
    }
    setError('');
    const kind = customKind;
    setDraft((prev) => ({
      ...prev,
      rows: [...prev.rows, { key: trimmedKey, kind, isCustom: true }],
      values: customValue ? { ...prev.values, [trimmedKey]: customValue } : prev.values,
      deletedKeys: prev.deletedKeys.filter((k) => k !== trimmedKey),
    }));
    setCustomKey('');
    setCustomKind('text');
    setCustomValue('');
    setAddingCustom(false);
  };

  const removeFieldRow = (key: string) => {
    setDraft((prev) => {
      const nextValues = { ...prev.values };
      delete nextValues[key];
      const nextTokens = { ...prev.importTokens };
      delete nextTokens[key];
      const hadExisting = prev.existing?.fields.some((f) => f.key === key);
      return {
        ...prev,
        rows: prev.rows.filter((row) => row.key !== key),
        values: nextValues,
        importTokens: nextTokens,
        sshImport: key === 'privateKey' ? undefined : prev.sshImport,
        deletedKeys: hadExisting && !prev.deletedKeys.includes(key) ? [...prev.deletedKeys, key] : prev.deletedKeys,
      };
    });
  };

  const submit = async () => {
    if (busy || !available) return;
    const title = draft.title.trim();
    if (!title) {
      setError(t('请填写条目标题'));
      return;
    }
    if (draft.botIds !== undefined && draft.botIds.length === 0) {
      setError(t('请至少选择一个 Bot，或开启“所有 Bot 都可以用”'));
      return;
    }
    const fields: Record<string, string | null> = {};
    const fieldKinds: Record<string, VaultFieldKind> = {};
    for (const row of draft.rows) {
      fieldKinds[row.key] = row.kind;
      const val = draft.values[row.key];
      if (typeof val === 'string' && val.length > 0 && !draft.importTokens[row.key]) {
        fields[row.key] = val;
      }
    }
    for (const key of draft.deletedKeys) {
      if (!Object.hasOwn(fields, key) && !draft.importTokens[key]) {
        fields[key] = null;
      }
    }
    const hasAnyInput =
      Object.values(fields).some((v) => typeof v === 'string' && v.length > 0) ||
      Object.keys(draft.importTokens).length > 0;
    if (!draft.existing && !hasAnyInput) {
      setError(t('请至少填写一个字段内容'));
      return;
    }

    const tags = draft.tagsText
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const bindings = draft.bindings
      .map((b) => ({ kind: b.kind, value: b.value.trim() }))
      .filter((b) => b.value.length > 0);
    const payload: VaultItemWriteInput = {
      ...(draft.existing ? { id: draft.existing.id } : {}),
      ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
      category: draft.category,
      title,
      notes: draft.notes.trim(),
      tags,
      bindings,
      fields,
      fieldKinds,
      ...(Object.keys(draft.importTokens).length ? { importTokens: draft.importTokens } : {}),
      policy: draft.category === 'card' ? 'always-ask' : draft.policy,
      botIds: draft.botIds ?? [],
      allowInAutomation: draft.category === 'card' ? false : draft.allowInAutomation,
    };

    setBusy(true);
    setError('');
    try {
      const saved = await window.aelion.vaultSave(payload);
      clearRevealed();
      setShowInputPlain({});
      setDraft((prev) => ({ ...prev, values: {}, importTokens: {}, sshImport: undefined }));
      setAddingCustom(false);
      setCustomKey('');
      setCustomKind('text');
      setCustomValue('');
      onNotify(draft.existing ? t('保险库条目已更新') : t('已保存到保险库'));
      onSaved(saved);
    } catch (err) {
      setError(ipcErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const slugHint = normalizeSlug(draft.slug || draft.title, draft.category);
  const isCard = draft.category === 'card';
  const hasExisting = Boolean(draft.existing);

  return (
    <div
      className="modal-backdrop vault-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) clearSensitiveAndClose();
      }}
    >
      <section
        className="modal vault-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={hasExisting ? t('编辑保险库条目') : t('新增保险库条目')}
      >
        <header>
          <div className="vault-modal-title">
            <Icon name="lock" size={16} />
            <h2>{hasExisting ? t('编辑保险库条目') : t('新增保险库条目')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('关闭对话框')}
            disabled={busy}
            onClick={clearSensitiveAndClose}
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <form
          className="vault-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="vault-editor-scroll">
            <div className="vault-form-grid">
              <label className="vault-field-block">
                <span>{t('分类')}</span>
                <Select
                  aria-label={t('分类')}
                  value={draft.category}
                  disabled={busy}
                  onChange={(event) => handleCategoryChange(event.target.value as VaultCategory)}
                >
                  {VAULT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {t(VAULT_CATEGORY_LABELS[category])}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="vault-field-block">
                <span>{t('标题')}</span>
                <input
                  type="text"
                  autoFocus
                  maxLength={120}
                  disabled={busy}
                  placeholder={t('例如：GitHub 个人账号')}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>

              <label className="vault-field-block">
                <span>{t('引用别名 (Slug)')}</span>
                <input
                  type="text"
                  maxLength={64}
                  disabled={busy}
                  spellCheck={false}
                  placeholder={slugHint}
                  value={draft.slug}
                  onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                />
              </label>

              <label className="vault-field-block">
                <span>{t('标签')}</span>
                <input
                  type="text"
                  maxLength={120}
                  disabled={busy}
                  placeholder={t('可选，逗号分隔')}
                  value={draft.tagsText}
                  onChange={(event) => setDraft({ ...draft, tagsText: event.target.value })}
                />
              </label>
            </div>

            <label className="vault-field-block">
              <span>{t('用途说明（供 Bot 判断何时选用，勿填明文）')}</span>
              <input
                type="text"
                maxLength={300}
                disabled={busy}
                placeholder={t('例如：日常开发与代码托管账号')}
                value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
            </label>

            <div className="vault-subsection">
              <div className="vault-subsection-head">
                <h3>{t('凭据与字段')}</h3>
                <div className="vault-subsection-actions">
                  {draft.category === 'ssh_key' && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !available}
                      onClick={() => void importSshKey()}
                    >
                      <Icon name="folder" size={14} />
                      {t('从本地文件导入私钥')}
                    </button>
                  )}
                  {hasExisting && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !available}
                      onClick={() => (revealed ? clearRevealed() : void revealPlaintext())}
                    >
                      <Icon name={revealed ? 'eyeOff' : 'eye'} size={14} />
                      {revealed ? t('隐藏明文') : t('查看明文')}
                    </button>
                  )}
                </div>
              </div>

              {revealed && (
                <div className="vault-reveal-banner" role="status">
                  <Icon name="lock" size={14} />
                  <span>
                    {t('明文将在 {seconds} 秒后自动隐藏（切换窗口也会立即清除）', { seconds: revealSeconds })}
                  </span>
                </div>
              )}

              {draft.sshImport && (
                <div className="vault-import-chip">
                  <Icon name="file" size={14} />
                  <span>
                    {draft.sshImport.fileName} · {draft.sshImport.preview}
                    {draft.sshImport.encrypted ? ` · ${t('受口令保护')}` : ''}
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      setDraft((prev) => {
                        const nextTokens = { ...prev.importTokens };
                        delete nextTokens.privateKey;
                        return { ...prev, importTokens: nextTokens, sshImport: undefined };
                      })
                    }
                  >
                    {t('清除')}
                  </button>
                </div>
              )}

              <div className="vault-fields-list">
                {draft.rows.map((row) => {
                  const sensitive = isSensitiveFieldKind(row.kind);
                  const isPlainShown = Boolean(showInputPlain[row.key]);
                  const revealedValue = revealed?.[row.key];
                  const isPrivateKeyToken = row.key === 'privateKey' && Boolean(draft.importTokens.privateKey);
                  const fieldLabel = row.label ? t(row.label) : row.key;
                  const placeholder = row.existingPreview
                    ? t('留空则保持不变')
                    : row.placeholder || (sensitive ? '' : undefined);

                  return (
                    <div className="vault-field-item" key={row.key}>
                      <div className="vault-field-meta">
                        <label htmlFor={`vault-field-${row.key}`}>
                          <strong>{fieldLabel}</strong>
                          <code>{row.key}</code>
                        </label>
                        <div className="vault-field-badges">
                          {row.existingPreview && (
                            <span className="vault-preview-pill" title={t('当前已保存值的安全掩码预览')}>
                              {row.existingPreview}
                            </span>
                          )}
                          {(hasExisting || row.isCustom) && (
                            <button
                              type="button"
                              className="text-button danger-text"
                              disabled={busy}
                              onClick={() => removeFieldRow(row.key)}
                            >
                              {t('移除')}
                            </button>
                          )}
                        </div>
                      </div>

                      {row.kind === 'multiline_key' ? (
                        <textarea
                          id={`vault-field-${row.key}`}
                          rows={3}
                          spellCheck={false}
                          autoComplete="off"
                          disabled={busy || isPrivateKeyToken}
                          placeholder={
                            isPrivateKeyToken
                              ? t('已从本地文件导入，保存时直接加密写入')
                              : placeholder || ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
                          }
                          value={draft.values[row.key] || ''}
                          onChange={(event) => {
                            const nextVal = event.target.value;
                            setDraft((prev) => {
                              const nextTokens = { ...prev.importTokens };
                              delete nextTokens[row.key];
                              return {
                                ...prev,
                                values: { ...prev.values, [row.key]: nextVal },
                                deletedKeys:
                                  nextVal.length > 0 ? prev.deletedKeys.filter((k) => k !== row.key) : prev.deletedKeys,
                                importTokens: nextTokens,
                                sshImport: row.key === 'privateKey' ? undefined : prev.sshImport,
                              };
                            });
                          }}
                        />
                      ) : (
                        <div className="vault-input-wrap">
                          <input
                            id={`vault-field-${row.key}`}
                            type={sensitive && !isPlainShown ? 'password' : 'text'}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={busy}
                            placeholder={placeholder}
                            value={draft.values[row.key] || ''}
                            onChange={(event) => {
                              const nextVal = event.target.value;
                              setDraft((prev) => ({
                                ...prev,
                                values: { ...prev.values, [row.key]: nextVal },
                                deletedKeys:
                                  nextVal.length > 0 ? prev.deletedKeys.filter((k) => k !== row.key) : prev.deletedKeys,
                              }));
                            }}
                          />
                          {sensitive && (
                            <button
                              type="button"
                              className="icon-button vault-eye-button"
                              aria-label={isPlainShown ? t('隐藏输入') : t('显示输入')}
                              title={isPlainShown ? t('隐藏输入') : t('显示输入')}
                              onClick={() => setShowInputPlain((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
                            >
                              <Icon name={isPlainShown ? 'eyeOff' : 'eye'} size={15} />
                            </button>
                          )}
                        </div>
                      )}

                      {revealedValue !== undefined && (
                        <div className="vault-revealed-box">
                          <code className="vault-revealed-value">{revealedValue}</code>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              void navigator.clipboard.writeText(revealedValue).then(() => setCopiedKey(row.key));
                            }}
                          >
                            {copiedKey === row.key ? t('已复制') : t('复制')}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {addingCustom ? (
                <div className="vault-custom-builder">
                  <input
                    type="text"
                    placeholder={t('字段键名（如 token）')}
                    value={customKey}
                    spellCheck={false}
                    maxLength={48}
                    disabled={busy}
                    onChange={(event) => setCustomKey(event.target.value)}
                  />
                  <Select
                    aria-label={t('字段类型')}
                    value={customKind}
                    disabled={busy}
                    onChange={(event) => setCustomKind(event.target.value as VaultFieldKind)}
                  >
                    {FIELD_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(FIELD_KIND_LABELS[kind])}
                      </option>
                    ))}
                  </Select>
                  <input
                    type={isSensitiveFieldKind(customKind) ? 'password' : 'text'}
                    placeholder={t('字段值')}
                    autoComplete="off"
                    value={customValue}
                    disabled={busy}
                    onChange={(event) => setCustomValue(event.target.value)}
                  />
                  <div className="vault-custom-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setAddingCustom(false);
                        setCustomKey('');
                        setCustomKind('text');
                        setCustomValue('');
                      }}
                    >
                      {t('取消')}
                    </button>
                    <button type="button" className="primary-button" onClick={addCustomField}>
                      {t('添加')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-button vault-add-field-btn"
                  disabled={busy}
                  onClick={() => setAddingCustom(true)}
                >
                  <Icon name="plus" size={14} />
                  {t('添加自定义字段')}
                </button>
              )}
            </div>

            <div className="vault-subsection">
              <div className="vault-subsection-head">
                <h3>{t('访问授权与适用范围')}</h3>
              </div>

              <div className="vault-config-card">
                <label className="vault-config-row">
                  <div className="settings-row-copy">
                    <span>{t('使用授权策略')}</span>
                    <small>
                      {isCard ? t('支付卡强制每次使用前由人类确认') : t('控制 Bot 在工具中引用此条目时是否需要你确认')}
                    </small>
                  </div>
                  <Select
                    aria-label={t('使用授权策略')}
                    value={isCard ? 'always-ask' : draft.policy}
                    disabled={busy || isCard}
                    onChange={(event) => setDraft({ ...draft, policy: event.target.value as VaultAccessPolicy })}
                  >
                    {VAULT_ACCESS_POLICIES.map((policy) => (
                      <option key={policy} value={policy}>
                        {t(VAULT_POLICY_LABELS[policy])}
                      </option>
                    ))}
                  </Select>
                </label>

                <div className="vault-bindings-block">
                  <div className="vault-bindings-head">
                    <span>{t('绑定网站、主机、应用或 MCP')}</span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        setDraft({ ...draft, bindings: [...draft.bindings, { kind: 'domain', value: '' }] })
                      }
                    >
                      <Icon name="plus" size={13} />
                      {t('添加绑定')}
                    </button>
                  </div>
                  {draft.bindings.length > 0 && (
                    <div className="vault-bindings-list">
                      {draft.bindings.map((binding, index) => (
                        <div className="vault-binding-row" key={index}>
                          <Select
                            aria-label={t('绑定类型')}
                            value={binding.kind}
                            disabled={busy}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                bindings: draft.bindings.map((item, i) =>
                                  i === index ? { ...item, kind: event.target.value as VaultBinding['kind'] } : item,
                                ),
                              })
                            }
                          >
                            {BINDING_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {t(VAULT_BINDING_LABELS[kind])}
                              </option>
                            ))}
                          </Select>
                          <input
                            type="text"
                            maxLength={200}
                            disabled={busy}
                            placeholder={
                              binding.kind === 'domain'
                                ? 'github.com'
                                : binding.kind === 'host'
                                  ? 'prod.example.com'
                                  : binding.kind === 'app'
                                    ? 'Google Chrome'
                                    : 'github'
                            }
                            value={binding.value}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                bindings: draft.bindings.map((item, i) =>
                                  i === index ? { ...item, value: event.target.value } : item,
                                ),
                              })
                            }
                          />
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={t('移除绑定')}
                            disabled={busy}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                bindings: draft.bindings.filter((_, i) => i !== index),
                              })
                            }
                          >
                            <Icon name="close" size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="vault-config-row">
                  <div className="settings-row-copy">
                    <span>{t('所有 Bot 都可以用')}</span>
                    <small>{t('关闭后可指定仅部分 Bot 有权调用此条目')}</small>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label={t('所有 Bot 都可以用')}
                    aria-checked={!draft.botIds}
                    className={draft.botIds ? 'learning-switch' : 'learning-switch enabled'}
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, botIds: draft.botIds ? undefined : bots.map((b) => b.id) })}
                  >
                    <i />
                  </button>
                </div>

                {draft.botIds && (
                  <div className="vault-bots-grid">
                    {bots.map((bot) => (
                      <label className="vault-bot-option" key={bot.id}>
                        <input
                          type="checkbox"
                          checked={draft.botIds!.includes(bot.id)}
                          disabled={busy}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              botIds: event.target.checked
                                ? [...draft.botIds!, bot.id]
                                : draft.botIds!.filter((id) => id !== bot.id),
                            })
                          }
                        />
                        <Avatar bot={bot} size={20} />
                        <span>{bot.name}</span>
                      </label>
                    ))}
                  </div>
                )}

                <div className="vault-config-row">
                  <div className="settings-row-copy">
                    <span>{t('允许在定时自动化中使用')}</span>
                    <small>
                      {isCard
                        ? t('支付卡禁止在无人值守的定时自动化中使用')
                        : t('开启后，定时任务在后台可不经弹窗直接盲注此条目')}
                    </small>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label={t('允许在定时自动化中使用')}
                    aria-checked={!isCard && draft.allowInAutomation}
                    className={!isCard && draft.allowInAutomation ? 'learning-switch enabled' : 'learning-switch'}
                    disabled={busy || isCard}
                    onClick={() => !isCard && setDraft({ ...draft, allowInAutomation: !draft.allowInAutomation })}
                  >
                    <i />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <p className="vault-error" role="alert">
              {error}
            </p>
          )}

          <footer className="vault-modal-footer">
            <button type="button" className="secondary-button" disabled={busy} onClick={clearSensitiveAndClose}>
              {t('取消')}
            </button>
            <button type="submit" className="primary-button" disabled={busy || !available || !draft.title.trim()}>
              {busy ? t('正在保存…') : t('加密保存')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

/** Settings → 保险库: manage credentials & personal info with zero-exposure blind injection. */
export function VaultSettings({ bots, onNotify }: { bots: Bot[]; onNotify: (message: string) => void }) {
  const { t, language } = useI18n();
  const [overview, setOverview] = useState<VaultOverview>();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | VaultCategory>('all');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [copiedRef, setCopiedRef] = useState('');
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<VaultAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const next = await window.aelion.vaultOverview();
      setOverview(next);
    } catch (err) {
      onNotify(ipcErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const entries = await window.aelion.vaultAudit({ limit: 100 });
      setAudit(entries);
    } catch (err) {
      onNotify(ipcErrorText(err));
    } finally {
      setAuditLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!copiedRef) return;
    const timer = setTimeout(() => setCopiedRef(''), 1800);
    return () => clearTimeout(timer);
  }, [copiedRef]);

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  const filteredItems = useMemo(() => {
    const items = overview?.items || [];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      if (!terms.length) return true;
      const haystack = [
        item.title,
        item.slug,
        item.notes || '',
        ...item.tags,
        ...item.bindings.map((b) => `${b.kind}:${b.value}`),
        ...item.fields.map((f) => `${f.key} ${f.label || ''}`),
      ]
        .join(' ')
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [overview?.items, query, categoryFilter]);

  const copyReference = (ref: string) => {
    void navigator.clipboard.writeText(ref).then(
      () => {
        setCopiedRef(ref);
        onNotify(t('已复制引用占位符'));
      },
      () => onNotify(t('复制失败')),
    );
  };

  const deleteItem = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setBusy(true);
    try {
      await window.aelion.vaultDelete(id);
      setConfirmDeleteId('');
      onNotify(t('已删除'));
      await loadOverview();
      if (auditOpen) await loadAudit();
    } catch (err) {
      onNotify(ipcErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const available = overview?.available ?? true;
  const items = overview?.items || [];

  return (
    <>
      <SettingsSection
        title={t('保险库')}
        aside={items.length > 0 ? <small>{t('{count} 条', { count: items.length })}</small> : undefined}
      >
        <p className="vault-intro">
          {t('加密保存账号密码、个人资料、支付卡与密钥；所有 Bot 默认可调用，但全程看不到明文。')}
        </p>

        {overview && !overview.available && (
          <div className="computer-notice vault-unavailable" role="alert">
            <Icon name="alert" size={16} />
            <span>{t('系统加密存储不可用，当前无法保存或解密保险库条目。请检查系统钥匙串或凭据服务设置。')}</span>
          </div>
        )}

        <div className="vault-toolbar">
          <div className="vault-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              aria-label={t('搜索保险库')}
              placeholder={t('搜索标题、别名、域名或字段')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={!available || busy}
            onClick={() => setEditor(createEditorState())}
          >
            <Icon name="plus" size={15} />
            {t('新增条目')}
          </button>
        </div>

        <div className="vault-categories" role="group" aria-label={t('按分类筛选')}>
          <button
            type="button"
            className="vault-category-pill"
            aria-pressed={categoryFilter === 'all'}
            onClick={() => setCategoryFilter('all')}
          >
            {t('全部')}
            {items.length > 0 && <span>{items.length}</span>}
          </button>
          {VAULT_CATEGORIES.map((category) => {
            const count = items.filter((item) => item.category === category).length;
            return (
              <button
                key={category}
                type="button"
                className="vault-category-pill"
                aria-pressed={categoryFilter === category}
                onClick={() => setCategoryFilter(category)}
              >
                {t(VAULT_CATEGORY_LABELS[category])}
                {count > 0 && <span>{count}</span>}
              </button>
            );
          })}
        </div>

        {loading ? (
          <p className="settings-note" role="status">
            {t('加载中…')}
          </p>
        ) : filteredItems.length > 0 ? (
          <div className="vault-item-list">
            {filteredItems.map((item) => {
              const scopeLabel = !item.botIds?.length
                ? t('所有 Bot')
                : item.botIds.map((id) => botsById.get(id)?.name || id).join('、');
              const slugExample = `{{vault:${item.slug}.*}}`;
              return (
                <article className="settings-card vault-item-card" key={item.id}>
                  <div className="vault-item-head">
                    <div className="vault-item-title-row">
                      <Icon name="lock" size={15} />
                      <strong>{item.title}</strong>
                      <span className="vault-badge">{t(VAULT_CATEGORY_LABELS[item.category])}</span>
                      <span className="vault-badge is-policy">{t(VAULT_POLICY_LABELS[item.policy])}</span>
                      {item.allowInAutomation && <span className="vault-badge">{t('允许自动化')}</span>}
                      {item.unreadable && <span className="vault-badge is-warn">{t('无法解密')}</span>}
                    </div>
                    <div className="vault-item-actions">
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => setEditor(createEditorState(item))}
                      >
                        {t('编辑')}
                      </button>
                      <button
                        type="button"
                        className={confirmDeleteId === item.id ? 'text-button danger-text' : 'text-button'}
                        disabled={busy}
                        onBlur={() => setConfirmDeleteId((cur) => (cur === item.id ? '' : cur))}
                        onClick={() => void deleteItem(item.id)}
                      >
                        {confirmDeleteId === item.id ? t('确认删除') : t('删除')}
                      </button>
                    </div>
                  </div>

                  <div className="vault-item-ref-row">
                    <code className="vault-slug-code">{slugExample}</code>
                    {item.notes && <span className="vault-item-notes">{item.notes}</span>}
                  </div>

                  {item.bindings.length > 0 && (
                    <div className="vault-item-tags">
                      {item.bindings.map((binding, index) => (
                        <span className="vault-tag" key={`${binding.kind}-${binding.value}-${index}`}>
                          {t(VAULT_BINDING_LABELS[binding.kind])}: {binding.value}
                        </span>
                      ))}
                    </div>
                  )}

                  {item.fields.length > 0 && (
                    <div className="vault-item-fields">
                      {item.fields.map((field) => {
                        const refText = `{{vault:${item.slug}.${field.key}}}`;
                        const labelText = field.label || FIELD_LABEL_BY_KEY[field.key];
                        return (
                          <div className="vault-item-field-row" key={field.key}>
                            <span className="vault-field-name">
                              {labelText ? t(labelText) : field.key}
                              <small>{field.key}</small>
                              {field.derived && <em className="vault-derived-tag">{t('动态')}</em>}
                            </span>
                            <code className="vault-field-preview">{field.preview}</code>
                            <button
                              type="button"
                              className="text-button vault-copy-ref"
                              title={t('复制引用 {ref}', { ref: refText })}
                              onClick={() => copyReference(refText)}
                            >
                              {copiedRef === refText ? t('已复制') : t('复制引用')}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <footer className="vault-item-foot">
                    <span>
                      {t('可用范围：')}
                      {scopeLabel}
                    </span>
                    <span>
                      {item.lastUsedAt
                        ? t('上次使用：{time}', { time: new Date(item.lastUsedAt).toLocaleString(language) })
                        : t('尚未使用')}
                    </span>
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <SettingsEmpty
            icon="lock"
            title={query.trim() || categoryFilter !== 'all' ? t('没有匹配的保险库条目') : t('保险库还是空的')}
          />
        )}
      </SettingsSection>

      <details
        className="vault-audit-disclosure"
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setAuditOpen(open);
          if (open) void loadAudit();
        }}
      >
        <summary>
          <span>{t('使用记录')}</span>
          {auditOpen && (
            <button
              type="button"
              className="text-button"
              onClick={(event) => {
                event.preventDefault();
                void loadAudit();
              }}
            >
              {t('刷新')}
            </button>
          )}
        </summary>
        <div className="settings-card vault-audit-card">
          {auditLoading && !audit.length ? (
            <p className="settings-note" role="status">
              {t('加载中…')}
            </p>
          ) : audit.length > 0 ? (
            <ul className="vault-audit-list">
              {audit.map((entry) => {
                const botName = entry.botId ? botsById.get(entry.botId)?.name || entry.botId : undefined;
                return (
                  <li className="vault-audit-row" key={entry.id}>
                    <div className="vault-audit-main">
                      <span className={`vault-audit-action is-${entry.action}`}>
                        {t(AUDIT_ACTION_LABELS[entry.action])}
                      </span>
                      <strong>{entry.itemTitle}</strong>
                      {entry.fields.length > 0 && <code className="vault-audit-fields">{entry.fields.join(', ')}</code>}
                      {entry.decision && (
                        <span className="vault-badge">{t(AUDIT_DECISION_LABELS[entry.decision])}</span>
                      )}
                    </div>
                    <div className="vault-audit-meta">
                      <span>{new Date(entry.time).toLocaleString(language)}</span>
                      {botName && <span>{botName}</span>}
                      {entry.sink && <span>{t(VAULT_SINK_LABELS[entry.sink])}</span>}
                      {entry.target && <code title={entry.target}>{entry.target}</code>}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="settings-note">{t('暂无使用记录')}</p>
          )}
        </div>
      </details>

      {createPortal(
        <Presence>
          {editor && (
            <VaultItemDialog
              editor={editor}
              bots={bots}
              available={available}
              onClose={() => setEditor(null)}
              onSaved={() => {
                setEditor(null);
                void loadOverview();
                if (auditOpen) void loadAudit();
              }}
              onNotify={onNotify}
            />
          )}
        </Presence>,
        document.body,
      )}
    </>
  );
}
