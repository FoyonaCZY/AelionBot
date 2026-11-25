import { useContext, useEffect, useRef, useState } from 'react';
import type { Bot, InteractionAction, InteractionRequest } from '../../shared/types/core';
import type { VaultItemWriteInput, VaultSshImportResult } from '../../shared/types/vault-types';
import { VAULT_BINDING_LABELS, VAULT_CATEGORY_LABELS, VAULT_SINK_LABELS } from '../../shared/chat/activity';
import type { BotPalette } from '../../shared/chat/bot-colors';
import { BotAvatarContext } from '../bots/BotAvatarContext';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { Presence } from '../ui/Presence';
import { CompanionBadge } from '../bots/CompanionCard';
import { useI18n } from '../i18n';
import './interactions.css';
import '../settings/permission-modes.css';

type Permission = Extract<InteractionRequest, { kind: 'host_permission' }>;
type Takeover = Extract<InteractionRequest, { kind: 'vm_takeover' }>;
type Questions = Extract<InteractionRequest, { kind: 'user_input' }>;
type ComputerAccess = Extract<InteractionRequest, { kind: 'computer_use' }>;
type VaultInput = Extract<InteractionRequest, { kind: 'vault_input' }>;
type VaultUse = Extract<InteractionRequest, { kind: 'vault_use' }>;
const errorText = (error: unknown) =>
  (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '');

function useRequestBotName(botId: string) {
  const entry = useContext(BotAvatarContext).get(botId) as (BotPalette & { name?: string }) | undefined;
  return entry?.name;
}
function PermissionCard({ request, count }: { request: Permission; count: number }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const sending = useRef(false);
  const decide = async (action: 'allow' | 'allow-always' | 'deny') => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError('');
    try {
      await window.aelion.respondInteraction({ id: request.id, action });
    } catch (error) {
      setError(errorText(error));
      sending.current = false;
      setPending(false);
    }
  };
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 250);
    return () => clearTimeout(timer);
  }, []);
  const details = request.details,
    reviewing = request.approval?.phase === 'reviewing';
  const titles = {
    delete_file: '删除或移动本机文件',
    command: '执行本机命令',
    read_file: '读取本机文件',
    write_file: details.overwrite ? '覆盖本机文件' : '写入本机文件',
    mcp: '使用本机 MCP 服务',
  };
  return (
    <section
      id={`interaction-${request.id}`}
      className={`conversation-request permission-card companion-surface ${reviewing ? 'approval-reviewing' : ''}`}
      tabIndex={-1}
      aria-label={t('本机操作权限')}
    >
      <header>
        <CompanionBadge kind="permission" activity={reviewing ? 'thinking' : 'waiting'} />
        <div className="request-heading-copy">
          <h2>{t(titles[details.operation])}</h2>
        </div>
        <span className="request-status companion-status">
          {reviewing ? t('审核中') : count > 1 ? t('还有 {count} 项', { count: count - 1 }) : t('等待确认')}
        </span>
      </header>
      <div className="permission-body">
        {request.approval && (reviewing || request.approval.reason) && (
          <p className="approval-review-note" role="status">
            {reviewing
              ? t('{reviewer} 正在审核本次操作', { reviewer: request.approval.reviewer || t('审核模型') })
              : request.approval.decision === 'deny'
                ? t('自动审核未放行：{reason}', { reason: request.approval.reason || '' })
                : request.approval.reason}
          </p>
        )}
        <p className="permission-reason">{details.reason}</p>
        <div className="permission-scope">
          {details.cwd && (
            <div>
              <span>{t('工作目录')}</span>
              <code>{details.cwd}</code>
            </div>
          )}
          {details.path && (
            <div>
              <span>{t(details.operation === 'mcp' ? '来源配置' : '文件路径')}</span>
              <code>{details.path}</code>
            </div>
          )}
          {details.server && (
            <div>
              <span>{t('服务')}</span>
              <code>{details.server}</code>
            </div>
          )}
          {details.tool && (
            <div>
              <span>{t('操作')}</span>
              <code>{details.tool}</code>
            </div>
          )}
        </div>
        {details.command !== undefined && (
          <div className="permission-content">
            <span>{t('命令')}</span>
            <pre tabIndex={0}>{details.command}</pre>
          </div>
        )}
        {details.stdin !== undefined && (
          <div className="permission-content">
            <span>{t('标准输入')}</span>
            <pre tabIndex={0}>{details.stdin || t('（空）')}</pre>
          </div>
        )}
        {details.content !== undefined && (
          <div className="permission-content">
            <span>{t('写入内容')}</span>
            <pre tabIndex={0}>{details.content || t('（空文件）')}</pre>
          </div>
        )}
        {details.arguments && (
          <div className="permission-content">
            <span>{t('参数')}</span>
            <pre tabIndex={0}>{JSON.stringify(details.arguments, null, 2)}</pre>
          </div>
        )}
        {error && (
          <p className="permission-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <div className="permission-actions">
          <button
            type="button"
            className="companion-button permission-deny-button"
            disabled={pending}
            onClick={() => void decide('deny')}
          >
            {t('拒绝本次')}
          </button>
          {details.commandPattern && (
            <button
              type="button"
              className="companion-button permission-always-button"
              disabled={!ready || pending}
              aria-label={t('始终允许 {pattern}', { pattern: details.commandPattern.pattern })}
              aria-describedby={`interaction-${request.id}-always-scope`}
              onClick={(event) => {
                if (event.isTrusted && event.detail < 2) void decide('allow-always');
              }}
            >
              {t('始终允许')}
            </button>
          )}
          <button
            type="button"
            className="companion-button companion-primary"
            disabled={!ready || pending}
            onClick={(event) => {
              if (event.isTrusted && event.detail < 2) void decide('allow');
            }}
          >
            {pending ? t('正在处理…') : t('允许本次')}
          </button>
        </div>
        {details.commandPattern && (
          <div className="permission-always-scope" id={`interaction-${request.id}-always-scope`}>
            <div className="permission-pattern">
              <span>{t('始终允许范围')}</span>
              <code>{details.commandPattern.pattern}</code>
            </div>
            <span className="permission-pattern-scope">
              {t('当前工作目录')} · {t(details.commandPattern.kind === 'prefix' ? '命令前缀匹配' : '完整命令匹配')}
            </span>
          </div>
        )}
      </footer>
    </section>
  );
}
function ComputerAccessCard({ request }: { request: ComputerAccess }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const decide = async (action: 'allow' | 'deny') => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await window.aelion.respondInteraction({ id: request.id, action });
    } catch (error) {
      setError(errorText(error));
      setPending(false);
    }
  };
  // A click that was already on its way when the card appeared must not approve anything.
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 250);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section
      id={`interaction-${request.id}`}
      className="conversation-request permission-card computer-access-card companion-surface"
      tabIndex={-1}
      aria-label={t('电脑控制权限')}
    >
      <header>
        <CompanionBadge kind="permission" activity="waiting" />
        <div className="request-heading-copy">
          <h2>{t('操控这台电脑')}</h2>
        </div>
        <span className="request-status companion-status">{t('等待确认')}</span>
      </header>
      {error && (
        <div className="permission-body">
          <p className="permission-error" role="alert">
            {error}
          </p>
        </div>
      )}
      <footer>
        <div className="permission-actions">
          <button
            type="button"
            className="companion-button permission-deny-button"
            disabled={pending}
            onClick={() => void decide('deny')}
          >
            {t('拒绝')}
          </button>
          <button
            type="button"
            className="companion-button companion-primary"
            disabled={!ready || pending}
            onClick={(event) => {
              if (event.isTrusted && event.detail < 2) void decide('allow');
            }}
          >
            {pending ? t('正在处理…') : t('允许')}
          </button>
        </div>
      </footer>
    </section>
  );
}
function TakeoverCard({
  request,
  onTakeover,
}: {
  request: Takeover;
  onTakeover: (request: Takeover) => Promise<void>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const act = async (action: InteractionAction) => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      if (action === 'takeover') await onTakeover(request);
      else await window.aelion.respondInteraction({ id: request.id, action });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      id={`interaction-${request.id}`}
      className="conversation-request takeover-card companion-surface"
      tabIndex={-1}
      aria-label={t('需要人工接管')}
    >
      <header>
        <CompanionBadge kind="takeover" activity="waiting" />
        <div className="request-heading-copy">
          <h2>{t('接管工作电脑')}</h2>
        </div>
        <span className="request-status companion-status">
          {request.phase === 'controlling' ? t('接管中') : t('等待接管')}
        </span>
      </header>
      <div className="permission-body">
        <p className="permission-reason">{request.reason}</p>
        {error && (
          <p className="permission-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button type="button" className="companion-button" disabled={pending} onClick={() => void act('cancel')}>
          {t('取消任务')}
        </button>
        <button
          type="button"
          className="companion-button companion-primary"
          disabled={pending}
          onClick={() => void act('takeover')}
        >
          {request.phase === 'controlling' ? t('返回工作电脑') : t('接管电脑')}
        </button>
      </footer>
    </section>
  );
}
function VaultInputCard({ request, count }: { request: VaultInput; count: number }) {
  const { t } = useI18n();
  const botName = useRequestBotName(request.botId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [importTokens, setImportTokens] = useState<Record<string, string>>({});
  const [sshImports, setSshImports] = useState<Record<string, VaultSshImportResult>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);

  const clearFormState = () => {
    setValues({});
    setImportTokens({});
    setSshImports({});
    setRevealed({});
  };

  useEffect(() => {
    clearFormState();
    setPending(false);
    setError('');
    sending.current = false;
    return () => {
      clearFormState();
    };
  }, [request.id]);

  // Re-mask toggled-visible secret inputs whenever the window loses focus or tab becomes hidden.
  useEffect(() => {
    const remask = () => setRevealed({});
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') remask();
    };
    window.addEventListener('blur', remask);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', remask);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const importSshKey = async (fieldKey: string) => {
    if (pending || sending.current) return;
    setError('');
    try {
      const result = await window.aelion.vaultImportSshKey();
      if (!result) return;
      setValues((prev) => {
        const next = { ...prev };
        delete next[fieldKey];
        if (result.publicKey && !next.publicKey && request.fields.some((f) => f.key === 'publicKey')) {
          next.publicKey = result.publicKey;
        }
        return next;
      });
      setImportTokens((prev) => ({ ...prev, [fieldKey]: result.token }));
      setSshImports((prev) => ({ ...prev, [fieldKey]: result }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const hasValueFor = (key: string) => Boolean(values[key]?.trim() || importTokens[key]);
  const missingRequired = request.fields.some((field) => field.required && !hasValueFor(field.key));
  const hasAnyValue = request.fields.some((field) => hasValueFor(field.key));

  const submit = async () => {
    if (sending.current || pending || missingRequired || !hasAnyValue) return;
    const fields: Record<string, string> = {};
    const fieldKinds: VaultItemWriteInput['fieldKinds'] = {};
    for (const field of request.fields) {
      fieldKinds[field.key] = field.kind;
      const val = values[field.key];
      if (typeof val === 'string' && val.length > 0 && !importTokens[field.key]) {
        fields[field.key] = val;
      }
    }
    const vaultInput: VaultItemWriteInput = {
      ...(request.existingItemId ? { id: request.existingItemId } : {}),
      ...(request.suggestedSlug ? { slug: request.suggestedSlug } : {}),
      category: request.category,
      title: request.title,
      ...(request.bindings?.length ? { bindings: request.bindings } : {}),
      fields,
      fieldKinds,
      ...(Object.keys(importTokens).length ? { importTokens: { ...importTokens } } : {}),
    };

    sending.current = true;
    setPending(true);
    setError('');
    // Clear local plaintext inputs immediately on submit so secrets do not linger in component state.
    clearFormState();
    try {
      await window.aelion.respondInteraction({ id: request.id, action: 'submit', vaultInput });
    } catch (err) {
      setError(errorText(err));
      sending.current = false;
      setPending(false);
    }
  };

  const cancel = async () => {
    if (sending.current || pending) return;
    sending.current = true;
    setPending(true);
    setError('');
    clearFormState();
    try {
      await window.aelion.respondInteraction({ id: request.id, action: 'cancel' });
    } catch (err) {
      setError(errorText(err));
      sending.current = false;
      setPending(false);
    }
  };

  return (
    <form
      id={`interaction-${request.id}`}
      className="conversation-request permission-card vault-card companion-surface"
      tabIndex={-1}
      aria-label={t('保险库安全录入')}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <header>
        <CompanionBadge kind="permission" activity="waiting" />
        <div className="request-heading-copy">
          <div className="vault-card-kicker">
            <Icon name="lock" size={12} />
            <span>{botName || 'Bot'}</span>
            <span>·</span>
            <span>{t(VAULT_CATEGORY_LABELS[request.category])}</span>
          </div>
          <h2>{request.title}</h2>
        </div>
        <span className="request-status companion-status">
          {count > 1 ? t('还有 {count} 项', { count: count - 1 }) : t('安全录入')}
        </span>
      </header>
      <div className="permission-body">
        <p className="permission-reason">{request.reason}</p>
        {request.existingItemId && (
          <p className="vault-card-note">{t('内容将补充或更新到已有保险库条目，Bot 不会看到明文。')}</p>
        )}
        {request.bindings && request.bindings.length > 0 && (
          <div className="vault-card-bindings">
            {request.bindings.map((binding, index) => (
              <span key={`${binding.kind}-${binding.value}-${index}`}>
                {t(VAULT_BINDING_LABELS[binding.kind])}: {binding.value}
              </span>
            ))}
          </div>
        )}
        <div className="vault-card-fields">
          {request.fields.map((field) => {
            const sensitive =
              field.kind === 'password' ||
              field.kind === 'card_number' ||
              field.kind === 'cvv' ||
              field.kind === 'totp';
            const multiline = field.kind === 'multiline_key';
            const imported = sshImports[field.key];
            const canImportSsh =
              request.category === 'ssh_key' && (field.kind === 'multiline_key' || field.key === 'privateKey');

            return (
              <div className="vault-card-field" key={field.key}>
                <div className="vault-card-field-head">
                  <label htmlFor={`vault-input-${request.id}-${field.key}`}>
                    {field.label}
                    {field.required && <em aria-hidden="true"> *</em>}
                  </label>
                  {canImportSsh && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={pending}
                      onClick={() => void importSshKey(field.key)}
                    >
                      {t('从本地文件导入私钥')}
                    </button>
                  )}
                </div>
                {imported ? (
                  <div className="vault-card-imported">
                    <Icon name="file" size={14} />
                    <span>
                      {imported.fileName} · {imported.preview}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={pending}
                      onClick={() => {
                        setImportTokens((prev) => {
                          const next = { ...prev };
                          delete next[field.key];
                          return next;
                        });
                        setSshImports((prev) => {
                          const next = { ...prev };
                          delete next[field.key];
                          return next;
                        });
                      }}
                    >
                      {t('清除')}
                    </button>
                  </div>
                ) : multiline ? (
                  <textarea
                    id={`vault-input-${request.id}-${field.key}`}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={pending}
                    placeholder={field.placeholder || ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')}
                    value={values[field.key] || ''}
                    onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  />
                ) : (
                  <div className="vault-card-input-wrap">
                    <input
                      id={`vault-input-${request.id}-${field.key}`}
                      type={
                        sensitive && !revealed[field.key]
                          ? 'password'
                          : field.kind === 'email'
                            ? 'email'
                            : field.kind === 'phone'
                              ? 'tel'
                              : 'text'
                      }
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending}
                      placeholder={field.placeholder}
                      value={values[field.key] || ''}
                      onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    />
                    {sensitive && (
                      <button
                        type="button"
                        className="icon-button vault-card-eye"
                        aria-label={revealed[field.key] ? t('隐藏输入') : t('显示输入')}
                        onClick={() => setRevealed((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                      >
                        <Icon name={revealed[field.key] ? 'eyeOff' : 'eye'} size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {error && (
          <p className="permission-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <div className="permission-actions">
          <button
            type="button"
            className="companion-button permission-deny-button"
            disabled={pending}
            onClick={() => void cancel()}
          >
            {t('取消')}
          </button>
          <button
            type="submit"
            className="companion-button companion-primary"
            disabled={pending || missingRequired || !hasAnyValue}
          >
            {pending ? t('正在保存…') : t('加密保存并继续')}
          </button>
        </div>
      </footer>
    </form>
  );
}

function VaultUseCard({ request, count }: { request: VaultUse; count: number }) {
  const { t } = useI18n();
  const botName = useRequestBotName(request.botId);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);

  useEffect(() => {
    setReady(false);
    setPending(false);
    setError('');
    sending.current = false;
    const timer = setTimeout(() => setReady(true), 250);
    return () => clearTimeout(timer);
  }, [request.id]);

  const decide = async (action: 'allow' | 'allow-run' | 'deny') => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError('');
    try {
      await window.aelion.respondInteraction({ id: request.id, action });
    } catch (err) {
      setError(errorText(err));
      sending.current = false;
      setPending(false);
    }
  };

  return (
    <section
      id={`interaction-${request.id}`}
      className={`conversation-request permission-card vault-card companion-surface ${request.bindingMismatch ? 'vault-mismatch' : ''}`}
      tabIndex={-1}
      aria-label={t('保险库使用确认')}
    >
      <header>
        <CompanionBadge kind="permission" activity="waiting" />
        <div className="request-heading-copy">
          <div className="vault-card-kicker">
            <Icon name="lock" size={12} />
            <span>{t('{name} 申请使用保险库凭据', { name: botName || 'Bot' })}</span>
            <span>·</span>
            <span>{t(VAULT_CATEGORY_LABELS[request.category])}</span>
          </div>
          <h2>{request.itemTitle}</h2>
        </div>
        <span className="request-status companion-status">
          {count > 1 ? t('还有 {count} 项', { count: count - 1 }) : t('等待确认')}
        </span>
      </header>
      <div className="permission-body">
        {request.bindingMismatch && (
          <div className="vault-mismatch-banner" role="alert">
            <div className="vault-mismatch-head">
              <Icon name="alert" size={15} />
              <strong>{t('目标与绑定范围不匹配')}</strong>
            </div>
            <p>{t('当前注入目标不在该条目允许的绑定范围之内，请仔细核对后再决定是否放行。')}</p>
            {request.expectedBindings && request.expectedBindings.length > 0 && (
              <div className="vault-card-bindings">
                <span>{t('预期绑定：')}</span>
                {request.expectedBindings.map((binding, index) => (
                  <span key={`${binding.kind}-${binding.value}-${index}`}>
                    {t(VAULT_BINDING_LABELS[binding.kind])}: {binding.value}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="permission-scope">
          <div>
            <span>{t('注入通道')}</span>
            <code>{t(VAULT_SINK_LABELS[request.sink])}</code>
          </div>
          {request.fields.length > 0 && (
            <div>
              <span>{t('涉及字段')}</span>
              <code>{request.fields.join(', ')}</code>
            </div>
          )}
          <div>
            <span>{t('注入目标')}</span>
            <code>{request.targetSummary}</code>
          </div>
        </div>
        {error && (
          <p className="permission-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <div className="permission-actions">
          <button
            type="button"
            className="companion-button permission-deny-button"
            disabled={pending}
            onClick={() => void decide('deny')}
          >
            {t('拒绝本次')}
          </button>
          {request.allowRunGrant && (
            <button
              type="button"
              className="companion-button permission-always-button"
              disabled={!ready || pending}
              onClick={(event) => {
                if (event.isTrusted && event.detail < 2) void decide('allow-run');
              }}
            >
              {t('本任务内允许此条目')}
            </button>
          )}
          <button
            type="button"
            className="companion-button companion-primary"
            disabled={!ready || pending}
            onClick={(event) => {
              if (event.isTrusted && event.detail < 2) void decide('allow');
            }}
          >
            {pending ? t('正在处理…') : t('允许本次')}
          </button>
        </div>
      </footer>
    </section>
  );
}

export function ConversationInteractions({
  requests,
  botId,
  onTakeover,
}: {
  requests: InteractionRequest[];
  botId: string;
  onTakeover: (request: Takeover) => Promise<void>;
}) {
  const pending = requests.filter(
      (request) =>
        request.botId === botId && (request.kind !== 'host_permission' || request.approval?.phase !== 'reviewing'),
    ),
    request = pending[0];
  if (!request) return null;
  return request.kind === 'host_permission' ? (
    <PermissionCard key={request.id} request={request} count={pending.length} />
  ) : request.kind === 'vault_input' ? (
    <VaultInputCard key={request.id} request={request} count={pending.length} />
  ) : request.kind === 'vault_use' ? (
    <VaultUseCard key={request.id} request={request} count={pending.length} />
  ) : request.kind === 'user_input' ? (
    <QuestionCard key={request.id} request={request} />
  ) : request.kind === 'computer_use' ? (
    <ComputerAccessCard key={request.id} request={request} />
  ) : (
    <TakeoverCard key={request.id} request={request} onTakeover={onTakeover} />
  );
}
function QuestionCard({ request }: { request: Questions }) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [sending, setSending] = useState(false),
    [error, setError] = useState('');
  const send = async () => {
    if (sending) return;
    setSending(true);
    setError('');
    try {
      await window.aelion.respondInteraction({ id: request.id, action: 'answer', answers });
    } catch (error) {
      setError(errorText(error));
      setSending(false);
    }
  };
  return (
    <form
      className="conversation-request question-card companion-surface"
      id={`interaction-${request.id}`}
      aria-label={t('回答 Bot 的问题')}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <header>
        <CompanionBadge kind="permission" activity="waiting" />
        <div className="request-heading-copy">
          <h2>{t('需要你的回答')}</h2>
        </div>
      </header>
      <div className="permission-body">
        {request.questions.map((question) => (
          <fieldset key={question.id} disabled={sending}>
            <legend>{question.title}</legend>
            {question.options?.map((option) => (
              <label className="question-option" key={option}>
                <input
                  type="radio"
                  name={`${request.id}-${question.id}`}
                  checked={answers[question.id] === option}
                  onChange={() => setAnswers({ ...answers, [question.id]: option })}
                />
                <span>{option}</span>
              </label>
            ))}
            <textarea
              aria-label={t('{title}：填写回答', { title: question.title })}
              placeholder={question.options ? t('也可以填写自己的答案') : t('填写回答')}
              value={question.options?.includes(answers[question.id]) ? '' : answers[question.id] || ''}
              maxLength={4000}
              rows={2}
              onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
            />
          </fieldset>
        ))}
        {error && (
          <p className="permission-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button
          className="companion-button companion-primary"
          disabled={sending || request.questions.some((question) => !answers[question.id]?.trim())}
        >
          {sending ? t('正在发送…') : t('发送回答')}
        </button>
      </footer>
    </form>
  );
}

export function InteractionNotifications({
  requests,
  bots,
  onView,
}: {
  requests: InteractionRequest[];
  bots: Bot[];
  onView: (request: InteractionRequest) => void;
}) {
  const { t } = useI18n();
  const seen = useRef(new Set<string>()),
    [visible, setVisible] = useState<string>(),
    [paused, setPaused] = useState(false);
  useEffect(() => {
    const incoming = requests.filter(
      (request) =>
        (request.kind === 'host_permission' ? request.approval?.phase !== 'reviewing' : request.phase === 'waiting') &&
        !seen.current.has(request.id),
    );
    for (const request of incoming) seen.current.add(request.id);
    if (incoming.length) {
      setPaused(false);
      setVisible(incoming.at(-1)!.id);
    }
  }, [requests]);
  useEffect(() => {
    if (!visible || paused) return;
    const timer = setTimeout(() => setVisible((current) => (current === visible ? undefined : current)), 6500);
    return () => clearTimeout(timer);
  }, [visible, paused]);
  const request = requests.find(
    (request) =>
      request.id === visible &&
      (request.kind === 'host_permission' ? request.approval?.phase !== 'reviewing' : request.phase === 'waiting'),
  );
  const bot = request && bots.find((bot) => bot.id === request.botId);
  return (
    <Presence>
      {request && (
        <aside
          className="interaction-notification companion-surface"
          role="status"
          aria-live="polite"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
          }}
        >
          <button
            className="interaction-notification-open"
            onClick={() => {
              setVisible(undefined);
              onView(request);
            }}
            aria-label={t('查看 {name} 的{kind}', {
              name: bot?.name || 'Bot',
              kind: t(
                request.kind === 'host_permission' || request.kind === 'computer_use'
                  ? '权限请求'
                  : request.kind === 'user_input'
                    ? '问题'
                    : request.kind === 'vault_input'
                      ? '安全录入请求'
                      : request.kind === 'vault_use'
                        ? '凭据使用授权'
                        : '接管请求',
              ),
            })}
          >
            {bot && <Avatar bot={bot} size={34} activity="waiting" />}
            <span>
              <strong>{bot?.name || 'Bot'}</strong>
              <small>
                {request.kind === 'host_permission'
                  ? t('等待你的本机操作许可')
                  : request.kind === 'user_input'
                    ? t('有问题需要你回答')
                    : request.kind === 'computer_use'
                      ? t('想操控这台电脑')
                      : request.kind === 'vault_input'
                        ? t('需要你安全录入「{title}」', { title: request.title })
                        : request.kind === 'vault_use'
                          ? t('申请使用「{title}」', { title: request.itemTitle })
                          : t('需要你接管工作电脑')}
              </small>
            </span>
            <span className="notification-view">
              {t('查看')}
              <Icon name="arrow" size={11} />
            </span>
          </button>
          <button
            className="icon-button notification-close"
            aria-label={t('关闭通知')}
            onClick={() => setVisible(undefined)}
          >
            <Icon name="close" size={16} />
          </button>
        </aside>
      )}
    </Presence>
  );
}
