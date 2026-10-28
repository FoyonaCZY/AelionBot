import { useRef, useState } from 'react';
import type { Snapshot } from '../../shared/types/core';
import {
  APP_CONNECTORS,
  APP_CONNECTOR_GROUPS,
  OAUTH_REDIRECT_URL,
  type AppConnector,
} from '../../shared/app-connectors';
import { AppLogo } from './AppLogo';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useSwitchMotion } from '../ui/motion';
import { useI18n } from '../i18n';
import './connectors.css';

const GOOGLE_GUIDE = 'https://developers.google.com/workspace/guides/configure-mcp-servers';

/** Picks an app, collects a token or Google client where needed, then signs in in the browser. */
export function AppConnectorDialog({
  state,
  onClose,
  onAdded,
}: {
  state: Snapshot;
  onClose: () => void;
  /** With the app's server ID, once it is added and, where it needs one, signed in. */
  onAdded: (id: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(''),
    [picked, setPicked] = useState<AppConnector>(),
    [token, setToken] = useState(''),
    [clientId, setClientId] = useState(''),
    [clientSecret, setClientSecret] = useState(''),
    [newClient, setNewClient] = useState(false),
    [signingIn, setSigningIn] = useState<{ id: string; app: AppConnector }>(),
    [pending, setPending] = useState(false),
    [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  const servers = state.integrations?.servers || [],
    hasGoogleClient = Boolean(state.integrations?.ownClients.includes('google')),
    words = query.trim().toLowerCase();
  const added = (app: AppConnector) => servers.find((server) => server.app === app.id);
  const run = async (operation: () => Promise<void>) => {
    setPending(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(ipcErrorText(e));
    } finally {
      setPending(false);
      setSigningIn(undefined);
    }
  };
  const connect = (app: AppConnector, input: { token?: string; clientId?: string; clientSecret?: string } = {}) =>
    run(async () => {
      const id = await window.aelion.addAppConnector({ app: app.id, ...input });
      if (app.auth === 'oauth' || app.auth === 'google') {
        setSigningIn({ id, app });
        await window.aelion.signInMcp(id);
      }
      onAdded(id);
    });
  const pick = (app: AppConnector) => {
    const existing = added(app);
    if (existing) return onAdded(existing.id);
    setError('');
    if (app.auth === 'token' || (app.auth === 'google' && !hasGoogleClient)) setPicked(app);
    else void connect(app);
  };
  const close = () => {
    if (signingIn) void window.aelion.cancelMcpSignIn(signingIn.id);
    onClose();
  };
  const google = picked?.auth === 'google';
  const dialog = useRef<HTMLDivElement>(null);
  useSwitchMotion(dialog, signingIn ? 'signing' : picked ? picked.id : '', ':scope > *');
  return (
    <div
      className="mcp-snippet-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) close();
      }}
    >
      <div
        ref={dialog}
        className="mcp-snippet-dialog connector-dialog app-dialog"
        role="dialog"
        aria-labelledby="app-dialog-title"
      >
        {signingIn ? (
          <div className="app-signing" role="status">
            <span className="connector-mark is-large">
              <AppLogo app={signingIn.app.id} size={30} />
            </span>
            <h2 id="app-dialog-title">{t('在浏览器里登录 {name}', { name: t(signingIn.app.name) })}</h2>
            <p>{t('登录页已经在浏览器里打开。登录并允许访问后，回到这里就能用了。')}</p>
            <button type="button" className="secondary-button" onClick={close}>
              {t('取消')}
            </button>
          </div>
        ) : picked ? (
          <>
            <button type="button" className="text-button app-back" onClick={() => setPicked(undefined)}>
              <Icon name="back" size={14} />
              {t('全部应用')}
            </button>
            <div className="app-picked">
              <span className="connector-mark is-large">
                <AppLogo app={picked.id} size={30} />
              </span>
              <div>
                <h2 id="app-dialog-title">{t(picked.name)}</h2>
                <p>{t(picked.description)}</p>
              </div>
            </div>
            {google ? (
              <div className="connector-manual">
                {hasGoogleClient && !newClient ? (
                  <p className="app-note">
                    {t('将使用你已保存的 Google OAuth 客户端。')}
                    <button type="button" className="text-button" onClick={() => setNewClient(true)}>
                      {t('更换客户端')}
                    </button>
                  </p>
                ) : (
                  <>
                    <p className="app-note">
                      {t('Google 要求用你自己的 Google Cloud 项目登录。只需设置一次，之后所有 Google 应用共用。')}
                    </p>
                    <ol>
                      <li>
                        {t(
                          '在 Google Cloud 控制台新建项目，启用要用的 API 和对应的 MCP 服务，例如 Gmail API 和 Gmail MCP API。',
                        )}
                      </li>
                      <li>{t('在 Google Auth Platform 里配置同意屏幕，把要用的权限加到“数据访问”。')}</li>
                      <li>
                        {t(
                          '新建 OAuth 客户端，类型选“Web 应用”，勾选“Use this client for an AI-powered agent”，已获授权的重定向 URI 填：',
                        )}
                        <span className="app-redirect">
                          <code>{OAUTH_REDIRECT_URL}</code>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              void navigator.clipboard.writeText(OAUTH_REDIRECT_URL).then(() => setCopied(true))
                            }
                          >
                            {copied ? t('已复制') : t('复制')}
                          </button>
                        </span>
                      </li>
                      <li>{t('把客户端 ID 和密钥填在下面。')}</li>
                    </ol>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void window.aelion.openExternalUrl(GOOGLE_GUIDE)}
                    >
                      {t('查看 Google 的设置说明')}
                    </button>
                    <label>
                      <span>{t('客户端 ID')}</span>
                      <input
                        value={clientId}
                        spellCheck={false}
                        placeholder="…apps.googleusercontent.com"
                        onChange={(event) => setClientId(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>{t('客户端密钥')}</span>
                      <input
                        type="password"
                        value={clientSecret}
                        spellCheck={false}
                        onChange={(event) => setClientSecret(event.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>
            ) : (
              <div className="connector-manual">
                <p className="app-note">
                  {t('{name} 用访问令牌连接。令牌只保存在这台电脑上，并且加密保存。', { name: t(picked.name) })}
                </p>
                {picked.tokenUrl && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void window.aelion.openExternalUrl(picked.tokenUrl!)}
                  >
                    {t('去 {name} 创建令牌', { name: t(picked.name) })}
                  </button>
                )}
                <label>
                  <span>{t('访问令牌')}</span>
                  <input
                    type="password"
                    value={token}
                    spellCheck={false}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </label>
              </div>
            )}
            {error && (
              <p className="mcp-snippet-error" role="alert">
                {error}
              </p>
            )}
            <div className="mcp-snippet-actions">
              <button className="secondary-button" type="button" disabled={pending} onClick={close}>
                {t('取消')}
              </button>
              <button
                className="primary-button"
                disabled={
                  pending ||
                  (google
                    ? (!hasGoogleClient || newClient) && (!clientId.trim() || !clientSecret.trim())
                    : !token.trim())
                }
                onClick={() =>
                  void connect(
                    picked,
                    google ? (!hasGoogleClient || newClient ? { clientId, clientSecret } : {}) : { token },
                  )
                }
              >
                {google ? t('登录') : t('连接')}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="app-dialog-title">{t('连接应用')}</h2>
            <p>{t('让 Bot 读写这些应用里的内容。在浏览器里登录，凭据加密保存在这台电脑上。')}</p>
            <label className="plugins-search app-search">
              <Icon name="search" size={15} />
              <input
                type="search"
                aria-label={t('搜索应用')}
                placeholder={t('搜索应用')}
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {error && (
              <p className="mcp-snippet-error" role="alert">
                {error}
              </p>
            )}
            <div className="app-groups">
              {APP_CONNECTOR_GROUPS.map((group) => {
                const apps = APP_CONNECTORS.filter(
                  (app) =>
                    app.group === group.id &&
                    `${app.name} ${t(app.name)} ${t(app.description)}`.toLowerCase().includes(words),
                );
                if (!apps.length) return null;
                return (
                  <section key={group.id} aria-label={t(group.name)}>
                    <h3>{t(group.name)}</h3>
                    <div className="app-grid">
                      {apps.map((app) => (
                        <button
                          key={app.id}
                          type="button"
                          className="app-option"
                          disabled={pending}
                          onClick={() => pick(app)}
                        >
                          <span className="connector-mark">
                            <AppLogo app={app.id} size={22} />
                          </span>
                          <span className="app-option-text">
                            <strong>{t(app.name)}</strong>
                            <small>{t(app.description)}</small>
                          </span>
                          {added(app) ? (
                            <em className="is-added">{t('已添加')}</em>
                          ) : app.auth === 'token' ? (
                            <em>{t('令牌')}</em>
                          ) : app.auth === 'google' ? (
                            <em>{t('自有客户端')}</em>
                          ) : app.local ? (
                            <em>{t('本机')}</em>
                          ) : app.auth === 'none' ? (
                            <em>{t('免登录')}</em>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="mcp-snippet-actions">
              <button className="secondary-button" type="button" onClick={close}>
                {t('关闭')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
