import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bot, IntegrationSource, McpServerView, Skill } from '../../shared/types/core';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
import { useI18n } from '../i18n';
import Markdown from '../chat/MessageMarkdown';
import { SkillControls } from './IntegrationSettings';
import { PluginIcon, mcpStatusText, sinceText } from './plugin-visuals';
import { ipcErrorText } from '../ui/ipc-error';
import { APP_CONNECTORS } from '../../shared/app-connectors';
export function PluginSwitch({
  name,
  enabled,
  disabled,
  onChange,
}: {
  name: string;
  enabled: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="plugin-switch"
      role="switch"
      aria-label={`${t('启用')} ${name}`}
      aria-checked={enabled}
      title={`${enabled ? t('停用') : t('启用')} ${name}`}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
/** A panel over the right side of the plugins page; the list stays behind it, so closing returns to the same place. */
export function PluginDrawer({
  label,
  onClose,
  aside,
  footer,
  children,
}: {
  label: string;
  onClose: () => void;
  /** Controls at the right of the top bar, usually the on/off switch. */
  aside?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);
  return (
    <div className="plugin-drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        ref={panel}
        className="plugin-drawer"
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="plugin-drawer-bar">
          <button type="button" className="plugin-back" onClick={onClose}>
            <Icon name="back" size={15} />
            {t('关闭')}
          </button>
          {aside}
        </div>
        <div className="plugin-drawer-body">{children}</div>
        {footer && <div className="plugin-drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}
export function StatusDot({ status }: { status: string }) {
  return <i className={`plugin-dot ${status}`} aria-hidden="true" />;
}
type Act = (operation: () => Promise<unknown>) => Promise<void>;
export function PluginDetails({
  skill,
  server,
  owner,
  sources,
  busy,
  act,
  onClose,
}: {
  skill?: Skill;
  server?: McpServerView;
  owner?: Bot;
  sources: IntegrationSource[];
  busy: boolean;
  act: Act;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const [full, setFull] = useState<Skill>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [tab, setTab] = useState<'body' | 'files'>('body'),
    [testResult, setTestResult] = useState(''),
    [signInError, setSignInError] = useState(''),
    [confirmRemove, setConfirmRemove] = useState(false);
  const tabPanel = useRef<HTMLDivElement>(null);
  useSwitchMotion(tabPanel, tab);
  useEffect(() => {
    if (!skill) return;
    let active = true;
    setFull(undefined);
    setError('');
    setLoading(true);
    window.aelion
      .readSkill({ id: skill.id, botId: skill.botId })
      .then((value) => {
        if (active) setFull(value);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [skill?.id]);
  const reload = async () => {
    if (skill) setFull(await window.aelion.readSkill({ id: skill.id, botId: skill.botId }));
  };
  const app = APP_CONNECTORS.find((item) => item.id === server?.app);
  const enabled = skill ? (skill.enabled ?? !skill.archived) : Boolean(server?.enabled),
    name = skill?.name || (app ? t(app.name) : server?.name) || '';
  const toggle = () =>
    void act(() =>
      skill
        ? window.aelion.setSkillEnabled({ id: skill.id, enabled: !enabled })
        : window.aelion.setMcpEnabled({ id: server!.id, enabled: !enabled }),
    );
  const cannotToggle =
    busy || Boolean(server && (server.status === 'connecting' || (!enabled && server.status === 'needs-config')));
  if (!skill && !server)
    return (
      <PluginDrawer label={t('插件')} onClose={onClose}>
        <p className="subtle">{t('这个插件已被移除。')}</p>
      </PluginDrawer>
    );
  const toggleControl = (
    <label className="plugin-drawer-switch">
      {enabled ? t('已启用') : t('未启用')}
      <PluginSwitch name={name} enabled={enabled} disabled={cannotToggle} onChange={toggle} />
    </label>
  );
  if (skill) {
    const files = full?.availableFiles || [],
      source = sources.find((item) => item.kind === 'skills' && item.label === skill.source?.label);
    return (
      <PluginDrawer
        label={name}
        onClose={onClose}
        aside={toggleControl}
        footer={
          <>
            <code className="plugin-drawer-path" title={skill.source?.path}>
              {skill.source?.path}
            </code>
            {(skill.botId || source) && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    window.aelion.openIntegrationPath(
                      skill.botId ? { kind: 'private-skills' } : { kind: 'source', id: source!.id },
                    ),
                  )
                }
              >
                <Icon name="folder" size={14} />
                {t('打开文件夹')}
              </button>
            )}
          </>
        }
      >
        <header className="plugin-hero">
          <PluginIcon skill={skill} owner={owner} size={48} />
          <div>
            <h2>{name}</h2>
            <p>
              {skill.botId
                ? t('{name} 私有', { name: owner?.name || 'Bot' })
                : skill.source?.scope === 'builtin'
                  ? t('内置技能 · 所有 Bot 可用')
                  : t('{source} · 所有 Bot 可用', { source: t(skill.source?.label || '技能') })}
              {skill.source?.readonly ? ' · ' + t('只读') : ''}
            </p>
          </div>
        </header>
        {skill.description && <p className="plugin-hero-description">{skill.description}</p>}
        <dl className="plugin-facts">
          <div>
            <dt>{t('使用次数')}</dt>
            <dd>{t('{count} 次', { count: skill.readCount || 0 })}</dd>
          </div>
          <div>
            <dt>{t('最近使用')}</dt>
            <dd>{skill.lastReadAt ? sinceText(skill.lastReadAt, t, language) : t('还没用过')}</dd>
          </div>
          <div>
            <dt>{t('附带文件')}</dt>
            <dd>{full ? t('{count} 个', { count: files.length }) : '…'}</dd>
          </div>
        </dl>
        <div className="plugin-tabs" role="tablist" aria-label={t('技能内容')}>
          <button type="button" role="tab" aria-selected={tab === 'body'} onClick={() => setTab('body')}>
            SKILL.md
          </button>
          <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
            {t('文件')}
            <span>{files.length}</span>
          </button>
        </div>
        {loading ? (
          <p className="subtle" role="status">
            {t('正在读取 SKILL.md…')}
          </p>
        ) : error ? (
          <p role="alert" className="computer-notice">
            {error}
          </p>
        ) : (
          <div ref={tabPanel} role="tabpanel">
            {tab === 'body' ? (
              <div className="plugin-detail-body markdown">
                <Markdown>{full?.body || skill.body}</Markdown>
              </div>
            ) : files.length ? (
              <ul className="plugin-files">
                {files.map((path) => (
                  <li key={path}>
                    <Icon name="file" size={14} />
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtle">{t('这个技能只有 SKILL.md。')}</p>
            )}
          </div>
        )}
        {(full?.compatibility || skill.compatibility) && (
          <p className="subtle">
            {t('适用环境：{value}', { value: full?.compatibility || skill.compatibility || '' })}
          </p>
        )}
        {owner && enabled && <SkillControls hideArchive skill={full || skill} botId={owner.id} onChanged={reload} />}
      </PluginDrawer>
    );
  }
  const mcp = server!;
  // Signing in waits for the browser, so it does not hold the page busy.
  const signIn = () => {
    setSignInError('');
    window.aelion.signInMcp(mcp.id).catch((error) => {
      if ((error as { code?: string }).code !== 'mcp.signin_cancelled') setSignInError(ipcErrorText(error));
    });
  };
  return (
    <PluginDrawer
      label={name}
      onClose={onClose}
      aside={toggleControl}
      footer={
        confirmRemove ? (
          <>
            <span className="plugin-drawer-warning">{t('移除后 Bot 不能再用这个服务，登录信息也会删除。')}</span>
            <button className="secondary-button" disabled={busy} onClick={() => setConfirmRemove(false)}>
              {t('取消')}
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await window.aelion.removeMcpServer(mcp.id);
                  onClose();
                })
              }
            >
              {t('确认移除')}
            </button>
          </>
        ) : (
          <>
            <code className="plugin-drawer-path" title={mcp.source.path}>
              {mcp.source.path}
            </code>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void act(() => window.aelion.openIntegrationPath({ kind: 'source', id: mcp.id }))}
            >
              <Icon name="folder" size={14} />
              {t('查看来源')}
            </button>
            {!mcp.source.readonly && (
              <button className="text-button danger-text" disabled={busy} onClick={() => setConfirmRemove(true)}>
                {t('移除')}
              </button>
            )}
          </>
        )
      }
    >
      <header className="plugin-hero">
        <PluginIcon server={mcp} size={48} />
        <div>
          <h2>{name}</h2>
          <p>
            <StatusDot status={mcp.status} />
            {t(mcpStatusText(mcp))}
            {mcp.toolCount !== undefined && ' · ' + t('{count} 个工具', { count: mcp.toolCount })}
          </p>
        </div>
      </header>
      {app && <p className="plugin-hero-description">{t(app.description)}</p>}
      {mcp.issue && mcp.login !== 'signed-out' && (
        <p className="computer-notice" role="alert">
          {mcp.issue}
        </p>
      )}
      {mcp.login && (
        <div className="plugin-account">
          <span>
            <strong>
              {mcp.login === 'signed-in' ? t('已登录') : mcp.login === 'signing-in' ? t('登录中') : t('未登录')}
            </strong>
            <small>
              {mcp.login === 'signed-in'
                ? app?.auth === 'token'
                  ? t('使用你提供的访问令牌，加密保存在这台电脑上')
                  : t('登录凭据加密保存在这台电脑上，过期后自动续期')
                : mcp.login === 'signing-in'
                  ? t('在浏览器里完成登录')
                  : t('登录后 Bot 才能使用这个服务')}
            </small>
          </span>
          {mcp.login === 'signing-in' ? (
            <button className="secondary-button" onClick={() => void window.aelion.cancelMcpSignIn(mcp.id)}>
              {t('取消')}
            </button>
          ) : mcp.login === 'signed-in' ? (
            // A pasted token is changed by removing the app and adding it again.
            app?.auth !== 'token' && (
              <>
                <button className="text-button" onClick={signIn}>
                  {t('重新登录')}
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void act(() => window.aelion.signOutMcp(mcp.id))}
                >
                  {t('退出登录')}
                </button>
              </>
            )
          ) : app?.auth === 'token' ? null : (
            <button className="primary-button" onClick={signIn}>
              {t('登录')}
            </button>
          )}
        </div>
      )}
      {signInError && (
        <p className="computer-notice" role="alert">
          {signInError}
        </p>
      )}
      <dl className="plugin-meta">
        <div>
          <dt>{t('连接方式')}</dt>
          <dd>{mcp.transport.toUpperCase()}</dd>
        </div>
        <div>
          <dt>{t('地址')}</dt>
          <dd>{mcp.endpoint}</dd>
        </div>
        <div>
          <dt>{t('来源')}</dt>
          <dd>{t(mcp.source.label)}</dd>
        </div>
      </dl>
      <div className="plugin-detail-actions">
        <button
          className="secondary-button"
          disabled={busy || !enabled || mcp.status === 'needs-config' || mcp.status === 'connecting'}
          onClick={() =>
            void act(async () => {
              setTestResult(t('正在握手并读取工具目录…'));
              try {
                const result = await window.aelion.testMcp(mcp.id);
                setTestResult(
                  t('握手成功：{count} 个工具{details}', {
                    count: result.tools.length,
                    details: result.tools.length ? ' · ' + result.tools.slice(0, 8).join('、') : '',
                  }),
                );
              } catch (e) {
                setTestResult(t('连接失败，请检查状态提示。'));
                throw e;
              }
            })
          }
        >
          {t('测试连接')}
        </button>
      </div>
      {testResult && (
        <p className="plugin-test-result" role="status">
          {testResult}
        </p>
      )}
    </PluginDrawer>
  );
}
