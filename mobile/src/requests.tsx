// A Bot waiting on the user: a permission, a question, Vault approval/input, the work computer.
import { useEffect, useRef, useState } from 'react';
import { VAULT_BINDING_LABELS, VAULT_CATEGORY_LABELS, VAULT_SINK_LABELS } from '../../shared/chat/activity';
import type { InteractionAction } from '../../shared/types/core';
import type { VaultItemWriteInput } from '../../shared/types/vault-types';
import type { RemoteBot, RemoteRequest } from '../../shared/remote/protocol';
import { Avatar } from '../../src/ui/Avatar';
import { useI18n } from '../../src/i18n';
import { connection } from './connection';
import { I } from './icons';
import { timeLabel, toast } from './ui';

function describeRequest(request: RemoteRequest, t: (key: string, values?: Record<string, string | number>) => string) {
  if (request.kind === 'host_permission') {
    const details = request.details;
    const title = {
      command: t('运行本机命令'),
      read_file: t('读取本机文件'),
      write_file: t('修改本机文件'),
      delete_file: t('删除本机文件'),
      mcp: t('调用外部工具'),
    }[details.operation];
    const main =
      details.operation === 'command'
        ? details.command
        : details.operation === 'mcp'
          ? [details.server, details.tool].filter(Boolean).join(' · ')
          : details.path;
    return { title, main, code: details.operation === 'command', quick: true, mismatch: false };
  }
  if (request.kind === 'vault_use') {
    return {
      title: t('申请使用「{title}」', { title: request.itemTitle }),
      main: request.targetSummary,
      code: false,
      quick: false,
      mismatch: Boolean(request.bindingMismatch),
    };
  }
  if (request.kind === 'vault_input') {
    return {
      title: t('请求安全录入「{title}」', { title: request.title }),
      main: request.reason,
      code: false,
      quick: false,
      mismatch: false,
    };
  }
  if (request.kind === 'computer_use') return { title: t('想操作你的电脑'), quick: true, mismatch: false };
  if (request.kind === 'user_input')
    return { title: t('有问题想问你'), main: request.questions[0]?.title, mismatch: false };
  return { title: t('需要你处理工作电脑'), main: request.reason, mismatch: false };
}

async function respond(
  id: string,
  action: InteractionAction,
  extra?: { answers?: Record<string, string>; vaultInput?: VaultItemWriteInput },
) {
  try {
    await connection.call('request.respond', {
      id,
      action,
      ...(extra?.answers ? { answers: extra.answers } : {}),
      ...(extra?.vaultInput ? { vaultInput: extra.vaultInput } : {}),
    });
  } catch (error) {
    toast((error as Error).message);
  }
}

/** On the home list: who asks and what; permissions are answered right here. */
export function RequestCard({ request, bot, onOpen }: { request: RemoteRequest; bot?: RemoteBot; onOpen: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const text = describeRequest(request, t);
  return (
    <div className="h-ask" style={bot ? ({ '--bot': bot.color } as React.CSSProperties) : undefined}>
      <button className="h-ask-head" onClick={onOpen}>
        {bot && <Avatar bot={bot} size={24} activity="waiting" />}
        <span className="h-ask-text">
          <b>{bot?.name}</b> {text.title}
        </span>
        <time>{timeLabel(request.createdAt)}</time>
      </button>
      {text.mismatch && <p className="h-ask-warn">{t('目标与绑定范围不匹配，请打开确认')}</p>}
      {text.main && (text.code ? <code>{text.main}</code> : <p>{text.main}</p>)}
      <div className="h-ask-actions">
        {text.quick ? (
          <>
            <button
              className="x-pill"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void respond(request.id, 'deny').finally(() => setBusy(false));
              }}
            >
              {t('拒绝')}
            </button>
            <button
              className="x-pill is-primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void respond(request.id, 'allow').finally(() => setBusy(false));
              }}
            >
              {t('允许')}
            </button>
          </>
        ) : (
          <button className="x-pill is-primary" onClick={onOpen}>
            {request.kind === 'user_input'
              ? t('去回答')
              : request.kind === 'vault_input'
                ? t('去录入')
                : request.kind === 'vault_use'
                  ? t('去确认')
                  : t('去处理')}
          </button>
        )}
      </div>
    </div>
  );
}

/** In a chat: takes the composer's place until answered. */
export function RequestDock({ request, onComputer }: { request: RemoteRequest; onComputer: () => void }) {
  const { t } = useI18n();
  const [details, setDetails] = useState(false);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [vaultValues, setVaultValues] = useState<Record<string, string>>({});
  const [vaultPlain, setVaultPlain] = useState<Record<string, boolean>>({});
  const sending = useRef(false);

  const clearVaultState = () => {
    setVaultValues({});
    setVaultPlain({});
  };

  useEffect(() => {
    setDetails(false);
    setAlways(false);
    setBusy(false);
    setReady(false);
    setAnswers({});
    clearVaultState();
    sending.current = false;
    const timer = setTimeout(() => setReady(true), 250);
    return () => {
      clearTimeout(timer);
      clearVaultState();
    };
  }, [request.id]);

  // Re-mask toggled-visible secret fields whenever the browser window/tab loses focus.
  useEffect(() => {
    const remask = () => setVaultPlain({});
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

  const text = describeRequest(request, t);
  const act = (
    action: InteractionAction,
    extra?: { answers?: Record<string, string>; vaultInput?: VaultItemWriteInput },
  ) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    void respond(request.id, action, extra).finally(() => {
      sending.current = false;
      setBusy(false);
    });
  };
  const head = (
    <div className="c-dock-head">
      <span className="c-dock-icon">
        <I
          name={
            request.kind === 'user_input'
              ? 'user'
              : request.kind === 'host_permission'
                ? 'terminal'
                : request.kind === 'vault_use' || request.kind === 'vault_input'
                  ? 'lock'
                  : 'computer'
          }
          size={20}
        />
      </span>
      <b>{text.title}</b>
      {request.kind === 'host_permission' && (
        <button className="c-dock-more" onClick={() => setDetails(!details)}>
          {details ? t('收起') : t('详情')}
          <I name={details ? 'fold' : 'down'} size={14} stroke={2.2} />
        </button>
      )}
    </div>
  );
  if (request.kind === 'vault_input') {
    const missingRequired = request.fields.some((field) => field.required && !vaultValues[field.key]?.trim());
    const hasAnyValue = request.fields.some((field) => Boolean(vaultValues[field.key]?.trim()));
    const submitVault = () => {
      if (sending.current || busy || missingRequired || !hasAnyValue) return;
      const fields: Record<string, string> = {};
      const fieldKinds: VaultItemWriteInput['fieldKinds'] = {};
      for (const field of request.fields) {
        fieldKinds[field.key] = field.kind;
        const val = vaultValues[field.key];
        if (typeof val === 'string' && val.length > 0) {
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
      };
      // Clear local sensitive state immediately on submit.
      clearVaultState();
      act('submit', { vaultInput });
    };
    return (
      <div className="c-dock">
        {head}
        {request.reason && <p className="c-dock-text">{request.reason}</p>}
        <div className="c-vault-tags">
          <span>{t(VAULT_CATEGORY_LABELS[request.category])}</span>
          {request.bindings?.map((binding, index) => (
            <span key={`${binding.kind}-${binding.value}-${index}`}>
              {t(VAULT_BINDING_LABELS[binding.kind])}: {binding.value}
            </span>
          ))}
        </div>
        <div className="c-vault-fields">
          {request.fields.map((field) => {
            const sensitive =
              field.kind === 'password' ||
              field.kind === 'card_number' ||
              field.kind === 'cvv' ||
              field.kind === 'totp';
            return (
              <div className="c-vault-field" key={field.key}>
                <label htmlFor={`m-vault-${request.id}-${field.key}`}>
                  {field.label}
                  {field.required && <em> *</em>}
                </label>
                {field.kind === 'multiline_key' ? (
                  <textarea
                    id={`m-vault-${request.id}-${field.key}`}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    disabled={busy}
                    placeholder={field.placeholder || ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')}
                    value={vaultValues[field.key] || ''}
                    onChange={(event) => setVaultValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  />
                ) : (
                  <div className="c-vault-input-wrap">
                    <input
                      id={`m-vault-${request.id}-${field.key}`}
                      type={
                        sensitive && !vaultPlain[field.key]
                          ? 'password'
                          : field.kind === 'email'
                            ? 'email'
                            : field.kind === 'phone'
                              ? 'tel'
                              : 'text'
                      }
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      disabled={busy}
                      placeholder={field.placeholder}
                      value={vaultValues[field.key] || ''}
                      onChange={(event) => setVaultValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    />
                    {sensitive && (
                      <button
                        type="button"
                        className="c-vault-toggle"
                        onClick={() => setVaultPlain((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                      >
                        {vaultPlain[field.key] ? t('隐藏') : t('显示')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="x-pair">
          <button
            type="button"
            className="x-btn"
            disabled={busy}
            onClick={() => {
              clearVaultState();
              act('cancel');
            }}
          >
            {t('取消')}
          </button>
          <button
            type="button"
            className="x-btn is-primary"
            disabled={busy || missingRequired || !hasAnyValue}
            onClick={submitVault}
          >
            {busy ? t('正在保存…') : t('加密保存并继续')}
          </button>
        </div>
      </div>
    );
  }
  if (request.kind === 'vault_use') {
    return (
      <div className="c-dock">
        {head}
        {request.bindingMismatch && (
          <div className="c-vault-warn" role="alert">
            <b>{t('目标与绑定范围不匹配')}</b>
            <p>{t('当前注入目标不在该条目允许的绑定范围之内，请仔细核对后再决定是否放行。')}</p>
            {request.expectedBindings && request.expectedBindings.length > 0 && (
              <small>
                {t('预期绑定：')}
                {request.expectedBindings.map((b) => `${t(VAULT_BINDING_LABELS[b.kind])}: ${b.value}`).join(' · ')}
              </small>
            )}
          </div>
        )}
        <dl className="c-details c-vault-details">
          <dt>{t('分类')}</dt>
          <dd>{t(VAULT_CATEGORY_LABELS[request.category])}</dd>
          <dt>{t('注入通道')}</dt>
          <dd>{t(VAULT_SINK_LABELS[request.sink])}</dd>
          {request.fields.length > 0 && (
            <>
              <dt>{t('涉及字段')}</dt>
              <dd>{request.fields.join(', ')}</dd>
            </>
          )}
          <dt>{t('注入目标')}</dt>
          <dd>{request.targetSummary}</dd>
        </dl>
        <div className="x-pair">
          <button type="button" className="x-btn" disabled={busy} onClick={() => act('deny')}>
            {t('拒绝本次')}
          </button>
          <button
            type="button"
            className="x-btn is-primary"
            disabled={!ready || busy}
            onClick={(event) => {
              if (event.isTrusted && event.detail < 2) act('allow');
            }}
          >
            {t('允许本次')}
          </button>
        </div>
        {request.allowRunGrant && (
          <button
            type="button"
            className="x-btn is-wide c-vault-run-btn"
            disabled={!ready || busy}
            onClick={(event) => {
              if (event.isTrusted && event.detail < 2) act('allow-run');
            }}
          >
            {t('本任务内允许此条目')}
          </button>
        )}
      </div>
    );
  }
  if (request.kind === 'user_input') {
    const complete = request.questions.every((question) => answers[question.id]?.trim());
    return (
      <div className="c-dock">
        {head}
        <div className="c-questions">
          {request.questions.map((question) => (
            <div key={question.id} className="c-question">
              <p>{question.title}</p>
              {question.options?.length ? (
                <div className="c-options">
                  {question.options.map((option) => (
                    <button
                      key={option}
                      className={'c-option' + (answers[question.id] === option ? ' is-picked' : '')}
                      onClick={() => setAnswers({ ...answers, [question.id]: option })}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                rows={1}
                placeholder={question.options?.length ? t('或者写你的回答') : t('写你的回答')}
                value={question.options?.includes(answers[question.id]) ? '' : answers[question.id] || ''}
                onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
              />
            </div>
          ))}
        </div>
        <button
          className="x-btn is-primary is-wide"
          disabled={busy || !complete}
          onClick={() => act('answer', { answers })}
        >
          {t('发送回答')}
        </button>
      </div>
    );
  }
  if (request.kind === 'vm_takeover')
    return (
      <div className="c-dock">
        {head}
        {text.main && <p className="c-dock-text">{text.main}</p>}
        {request.phase === 'controlling' ? (
          <div className="x-pair">
            <button className="x-btn" onClick={onComputer}>
              {t('打开工作电脑')}
            </button>
            <button className="x-btn is-primary" disabled={busy} onClick={() => act('resume')}>
              {t('交还给 Bot')}
            </button>
          </div>
        ) : (
          <div className="x-pair">
            <button className="x-btn" disabled={busy} onClick={() => act('cancel')}>
              {t('取消')}
            </button>
            <button
              className="x-btn is-primary"
              disabled={busy}
              onClick={() => {
                act('takeover');
                onComputer();
              }}
            >
              {t('去处理')}
            </button>
          </div>
        )}
      </div>
    );
  const permission = request.kind === 'host_permission' ? request.details : undefined;
  return (
    <div className="c-dock">
      {head}
      {text.main && <code className="c-cmd">{text.main}</code>}
      {details && permission && (
        <dl className="c-details">
          {permission.reason && (
            <>
              <dt>{t('原因')}</dt>
              <dd>{permission.reason}</dd>
            </>
          )}
          {permission.cwd && (
            <>
              <dt>{t('目录')}</dt>
              <dd>{permission.cwd}</dd>
            </>
          )}
          {request.kind === 'host_permission' && request.approval?.reason && (
            <>
              <dt>{t('审核')}</dt>
              <dd>{request.approval.reason}</dd>
            </>
          )}
          {permission.commandPattern && (
            <dd className="c-always">
              {always ? (
                <span className="c-always-confirm">
                  {t('以后在这个目录自动允许：{pattern}', {
                    pattern:
                      permission.commandPattern.pattern + (permission.commandPattern.kind === 'prefix' ? ' …' : ''),
                  })}
                  <span>
                    <button className="x-link" onClick={() => setAlways(false)}>
                      {t('取消')}
                    </button>
                    <button className="x-link is-strong" disabled={busy} onClick={() => act('allow-always')}>
                      {t('确定')}
                    </button>
                  </span>
                </span>
              ) : (
                <button className="x-link is-underline" onClick={() => setAlways(true)}>
                  {t('以后都允许这类命令')}
                </button>
              )}
            </dd>
          )}
        </dl>
      )}
      <div className="x-pair">
        <button className="x-btn" disabled={busy} onClick={() => act('deny')}>
          {t('拒绝')}
        </button>
        <button className="x-btn is-primary" disabled={busy} onClick={() => act('allow')}>
          {t('允许')}
        </button>
      </div>
    </div>
  );
}
