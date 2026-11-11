import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bot, McpServerView, Skill, Snapshot, WorkSession } from '../../shared/types/core';
import {
  CONNECTOR_PLATFORM_NAMES,
  type ConnectorPlatform,
  type ConnectorView,
} from '../../shared/types/connector-types';
import { IntegrationSources, McpSnippetDialog } from './IntegrationSettings';
import { PluginDetails, PluginDrawer, PluginSwitch, StatusDot } from './PluginDetails';
import { AddConnectorDialog, connectorName, connectorStatusText } from './AddConnectorDialog';
import { ConnectorDetails } from './ConnectorDetails';
import { ConnectorLogo } from './ConnectorLogo';
import { AppConnectorDialog } from './AppConnectorDialog';
import { AppLogo } from './AppLogo';
import { APP_CONNECTORS, APP_CONNECTOR_GROUPS, type AppConnector } from '../../shared/app-connectors';
import { PluginIcon, mcpStatusText, sinceText } from './plugin-visuals';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useSwitchMotion } from '../ui/motion';
import { Presence } from '../ui/Presence';
import { useI18n } from '../i18n';
import './plugins.css';
export type PluginFilter = 'all' | 'apps' | 'skills' | 'mcp' | 'connectors';
type Selected = { kind: 'skill' | 'mcp' | 'connector' | 'sources'; id: string };
type SkillGroup = { key: string; title: string; note: string; path?: string; bot?: Bot; skills: Skill[] };
const PLATFORMS: ConnectorPlatform[] = ['feishu', 'wecom', 'weixin'];
/** Apps recommended on the overview, to say what kind of thing can be connected. */
const FEATURED_APPS = ['notion', 'github', 'gmail', 'linear', 'supabase', 'figma-desktop'];
const appOf = (server: McpServerView) => APP_CONNECTORS.find((app) => app.id === server.app);
/** How many skills of a group the overview shows before "view all". */
const OVERVIEW_SKILLS = 6;
export function PluginsPage({
  state,
  initialFilter = 'all',
  busy,
  act,
  onClose,
  onOpenSession,
}: {
  state: Snapshot;
  initialFilter?: PluginFilter;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  onOpenSession: (session: WorkSession) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState<PluginFilter>(initialFilter),
    [selected, setSelected] = useState<Selected>(),
    [adding, setAdding] = useState<'menu' | 'mcp' | ConnectorPlatform>(),
    [connecting, setConnecting] = useState<AppConnector>(),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [connectorError, setConnectorError] = useState(''),
    [appError, setAppError] = useState(''),
    heading = useRef<HTMLHeadingElement>(null),
    search = useRef<HTMLInputElement>(null),
    content = useRef<HTMLDivElement>(null);
  useSwitchMotion(content, filter, ':scope > :is(.plugins-section, .plugins-empty)');
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [filter]);
  // Escape closes the dialog once nothing inside it (a menu, a drawer, a query in the search field) has taken it.
  const covered = Boolean(selected || adding || connecting);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (event.key === 'Escape' && !event.defaultPrevented && !covered) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [covered, onClose]);
  const words = query.trim().toLowerCase(),
    skills = state.skills,
    servers = state.integrations?.servers || [],
    connectors = state.connectors?.connectors || [],
    botOf = (id?: string) => state.bots.find((bot) => bot.id === id);
  const shownSkills = skills.filter((skill) =>
    `${skill.name} ${skill.description} ${t(skill.source?.label || '')} ${botOf(skill.botId)?.name || ''}`
      .toLowerCase()
      .includes(words),
  );
  // Servers added from the app catalog are listed as apps; the MCP list keeps the rest.
  const apps = servers.filter((server) => server.app),
    plainServers = servers.filter((server) => !server.app);
  const shownApps = apps.filter((server) =>
    `${server.name} ${t(appOf(server)?.name || '')} ${t(appOf(server)?.description || '')}`
      .toLowerCase()
      .includes(words),
  );
  const shownServers = plainServers.filter((server) =>
    `${server.name} ${t(server.source.label)}`.toLowerCase().includes(words),
  );
  const shownConnectors = connectors.filter((connector) =>
    `${t(CONNECTOR_PLATFORM_NAMES[connector.platform])} ${connector.account} ${botOf(connector.botId)?.name || ''}`
      .toLowerCase()
      .includes(words),
  );
  const addedApps = new Set(apps.map((server) => server.app));
  const catalog = APP_CONNECTORS.filter(
    (app) => !addedApps.has(app.id) && `${app.name} ${t(app.name)} ${t(app.description)}`.toLowerCase().includes(words),
  );
  const featured = FEATURED_APPS.flatMap((id) => catalog.find((app) => app.id === id) || []);
  // Another connector most likely joins the platform added last, such as a WeCom bot for another Bot.
  const nextPlatform: ConnectorPlatform = connectors.at(-1)?.platform || 'feishu';
  // Platforms still to connect; each has a row until it has a connector.
  const openPlatforms = PLATFORMS.filter(
    (platform) =>
      !connectors.some((connector) => connector.platform === platform) &&
      t(CONNECTOR_PLATFORM_NAMES[platform]).toLowerCase().includes(words),
  );
  const tabs: Array<{ id: PluginFilter; name: string }> = [
    { id: 'all', name: t('全部') },
    { id: 'apps', name: t('应用') },
    { id: 'skills', name: t('技能') },
    { id: 'connectors', name: t('消息渠道') },
    { id: 'mcp', name: 'MCP' },
  ];
  const show = (kind: PluginFilter) => filter === 'all' || filter === kind,
    // The overview recommends a few apps; the whole catalog shows under its own filter or for a search.
    wholeCatalog = filter === 'apps' || Boolean(words),
    nothing =
      (!show('skills') || !shownSkills.length) &&
      (!show('mcp') || !shownServers.length) &&
      (!show('apps') || (!shownApps.length && !catalog.length)) &&
      (!show('connectors') || (!shownConnectors.length && !openPlatforms.length)),
    toggleExpanded = (key: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
  // Connector actions stay available while Bots work; they report errors here rather than block on `busy`.
  const connectorAct = async (operation: () => Promise<unknown>) => {
    setConnectorError('');
    try {
      await operation();
    } catch (error) {
      setConnectorError(ipcErrorText(error));
    }
  };
  // Signing in waits for the browser, so it runs beside the page instead of holding it busy.
  const signIn = (id: string) => {
    setAppError('');
    window.aelion.signInMcp(id).catch((error) => {
      if ((error as { code?: string }).code !== 'mcp.signin_cancelled') setAppError(ipcErrorText(error));
    });
  };
  const skillGroups = groupSkills(shownSkills, state, t);
  const mcpGroups = [
    ...shownServers
      .reduce(
        (groups, server) => groups.set(server.name, [...(groups.get(server.name) || []), server]),
        new Map<string, McpServerView[]>(),
      )
      .values(),
  ];
  const usedSkills = skills.filter((skill) => skill.enabled ?? !skill.archived).length,
    connectedServers = plainServers.filter((server) => server.status === 'connected').length;
  return (
    <div
      className="plugins-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="plugins-page" role="dialog" aria-modal="true" aria-labelledby="plugins-heading">
        <button className="icon-button plugins-close" aria-label={t('返回聊天')} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <header className="plugins-header">
          <h1 id="plugins-heading" ref={heading} tabIndex={-1}>
            {t('插件')}
          </h1>
          {apps.length > 0 && (
            <button type="button" className="plugins-summary" onClick={() => setFilter('apps')}>
              <span className="connector-add-logos">
                {apps.slice(0, 3).map((server) => (
                  <span className="connector-mark is-small" key={server.id}>
                    <AppLogo app={server.app} size={14} />
                  </span>
                ))}
              </span>
              {t('已添加 {count} 个应用', { count: apps.length })}
              <Icon name="chevron" size={12} />
            </button>
          )}
        </header>
        <div className="plugins-toolbar">
          <label className="plugins-search">
            <Icon name="search" size={16} />
            <input
              ref={search}
              type="search"
              aria-label={t('搜索插件')}
              placeholder={t('搜索插件')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
            />
          </label>
          <AddMenu
            open={adding === 'menu'}
            busy={busy}
            onOpen={(open) => setAdding(open ? 'menu' : undefined)}
            onPick={(kind) => {
              if (kind === 'skills') {
                setAdding(undefined);
                void act(() => window.aelion.addIntegrationSource('skills'));
              } else if (kind === 'app') {
                setAdding(undefined);
                setFilter('apps');
                search.current?.focus();
              } else setAdding(kind === 'mcp' ? 'mcp' : nextPlatform);
            }}
          />
        </div>
        <nav className="plugins-tabs" aria-label={t('插件分类')}>
          {tabs.map((tab) => (
            <button key={tab.id} type="button" aria-current={filter === tab.id} onClick={() => setFilter(tab.id)}>
              {tab.name}
            </button>
          ))}
          <span className="plugins-tabs-spacer" />
          {state.integrations && (
            <button
              type="button"
              className="plugins-tab-link"
              title={t('来源与配置')}
              aria-label={t('来源与配置')}
              onClick={() => setSelected({ kind: 'sources', id: '' })}
            >
              <Icon name="folder" size={15} />
            </button>
          )}
          <button
            type="button"
            className="plugins-tab-link"
            title={t('重新扫描')}
            aria-label={t('重新扫描')}
            disabled={busy}
            onClick={() => void act(() => window.aelion.refreshIntegrations())}
          >
            <Icon name="restart" size={15} />
          </button>
        </nav>
        <div ref={content} className="plugins-body">
          {appError && (
            <p className="computer-notice" role="alert">
              {appError}
            </p>
          )}
          {show('apps') && shownApps.length > 0 && (
            <section className="plugins-section" aria-labelledby="plugins-apps-title">
              <div className="plugins-section-head">
                <h2 id="plugins-apps-title">{t('已连接')}</h2>
              </div>
              <div className="plugin-grid">
                {shownApps.map((server) => (
                  <AppRow
                    key={server.id}
                    server={server}
                    busy={busy}
                    act={act}
                    onSignIn={() => signIn(server.id)}
                    onOpen={() => setSelected({ kind: 'mcp', id: server.id })}
                  />
                ))}
              </div>
            </section>
          )}
          {show('apps') && !wholeCatalog && featured.length > 0 && (
            <section className="plugins-section" aria-labelledby="plugins-featured-title">
              <div className="plugins-section-head">
                <h2 id="plugins-featured-title">{t('为你推荐')}</h2>
                <button type="button" className="plugins-section-link" onClick={() => setFilter('apps')}>
                  {t('查看全部')}
                </button>
              </div>
              <div className="plugin-grid">
                {featured.map((app) => (
                  <CatalogRow key={app.id} app={app} busy={busy} onConnect={() => setConnecting(app)} />
                ))}
              </div>
            </section>
          )}
          {show('apps') &&
            wholeCatalog &&
            APP_CONNECTOR_GROUPS.map((group) => {
              const shown = catalog.filter((app) => app.group === group.id);
              if (!shown.length) return null;
              return (
                <section className="plugins-section" key={group.id} aria-label={t(group.name)}>
                  <div className="plugins-section-head">
                    <h2>{t(group.name)}</h2>
                  </div>
                  <div className="plugin-grid">
                    {shown.map((app) => (
                      <CatalogRow key={app.id} app={app} busy={busy} onConnect={() => setConnecting(app)} />
                    ))}
                  </div>
                </section>
              );
            })}
          {show('connectors') && (shownConnectors.length > 0 || openPlatforms.length > 0) && (
            <section className="plugins-section" aria-labelledby="plugins-connectors-title">
              <div className="plugins-section-head">
                <h2 id="plugins-connectors-title">{t('消息渠道')}</h2>
                <span>{t('在手机上给 Bot 发消息')}</span>
                {state.connectors && connectors.length > 0 && (
                  <label className="plugins-head-switch">
                    {t('关闭窗口后保持连接')}
                    <PluginSwitch
                      name={t('关闭窗口后保持连接')}
                      enabled={state.connectors.keepRunning}
                      disabled={false}
                      onChange={() =>
                        void connectorAct(() => window.aelion.setConnectorsKeepRunning(!state.connectors!.keepRunning))
                      }
                    />
                  </label>
                )}
                {connectors.length > 0 && (
                  <button
                    type="button"
                    className="plugins-section-link plugins-section-add"
                    aria-label={t('添加连接器')}
                    onClick={() => setAdding(nextPlatform)}
                  >
                    <Icon name="plus" size={13} />
                    {t('添加')}
                  </button>
                )}
              </div>
              {connectorError && (
                <p className="computer-notice" role="alert">
                  {connectorError}
                </p>
              )}
              {connectors.length === 0 && !words && (
                <p className="plugins-section-note">
                  {t(
                    '连接后，私聊消息会交给 Bot 在这台电脑上处理；企业微信群里 @ 它的消息也可以。做完把结果和文件发回去，不需要公网地址。',
                  )}
                </p>
              )}
              <div className="plugin-grid">
                {shownConnectors.map((connector) => (
                  <ConnectorRow
                    key={connector.id}
                    connector={connector}
                    name={connectorName(connector, state, t)}
                    bot={botOf(connector.botId)}
                    sessions={
                      (state.workSessions || []).filter((s) => s.connector?.connectorId === connector.id).length
                    }
                    onOpen={() => setSelected({ kind: 'connector', id: connector.id })}
                    onToggle={() =>
                      void connectorAct(() =>
                        window.aelion.updateConnector({ id: connector.id, enabled: !connector.enabled }),
                      )
                    }
                  />
                ))}
                {openPlatforms.map((platform) => (
                  <PluginRow
                    key={platform}
                    mark={
                      <span className="connector-mark">
                        <ConnectorLogo platform={platform} size={22} />
                      </span>
                    }
                    name={
                      <>
                        {t(CONNECTOR_PLATFORM_NAMES[platform])}
                        {platform === 'weixin' && <span className="plugin-tag">{t('实验')}</span>}
                      </>
                    }
                  >
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={t('连接 {name}', { name: t(CONNECTOR_PLATFORM_NAMES[platform]) })}
                      onClick={() => setAdding(platform)}
                    >
                      {t('去连接')}
                    </button>
                  </PluginRow>
                ))}
              </div>
            </section>
          )}
          {show('mcp') && shownServers.length > 0 && (
            <section className="plugins-section" aria-labelledby="plugins-mcp-title">
              <div className="plugins-section-head">
                <h2 id="plugins-mcp-title">{t('MCP 服务')}</h2>
                <span>
                  {t('{count} 个 · {connected} 个已连接', { count: plainServers.length, connected: connectedServers })}
                </span>
              </div>
              <div className="mcp-list">
                {mcpGroups.map((group) =>
                  group.length === 1 ? (
                    <McpRow
                      key={group[0].id}
                      server={group[0]}
                      busy={busy}
                      act={act}
                      onSignIn={() => signIn(group[0].id)}
                      onOpen={() => setSelected({ kind: 'mcp', id: group[0].id })}
                    />
                  ) : (
                    <McpGroup
                      key={'group:' + group[0].name}
                      servers={group}
                      open={expanded.has('mcp:' + group[0].name)}
                      onToggle={() => toggleExpanded('mcp:' + group[0].name)}
                      busy={busy}
                      act={act}
                      onSignIn={signIn}
                      onOpen={(id) => setSelected({ kind: 'mcp', id })}
                    />
                  ),
                )}
              </div>
            </section>
          )}
          {show('skills') && shownSkills.length > 0 && (
            <section className="plugins-section" aria-labelledby="plugins-skills-title">
              <div className="plugins-section-head">
                <h2 id="plugins-skills-title">{t('技能')}</h2>
                <span>{t('{count} 个 · {enabled} 个启用', { count: skills.length, enabled: usedSkills })}</span>
                {filter === 'all' && !words && (
                  <button type="button" className="plugins-section-link" onClick={() => setFilter('skills')}>
                    {t('查看全部')}
                  </button>
                )}
              </div>
              {skillGroups.map((group) => (
                <div className="skill-group" key={group.key}>
                  <h3>
                    <strong>{group.title}</strong>
                    {group.bot && <Avatar bot={group.bot} size={16} />}
                    <span>{group.note}</span>
                    {group.path && <code title={group.path}>{group.path}</code>}
                  </h3>
                  <div className="plugin-grid">
                    {(filter === 'all' && !words ? group.skills.slice(0, OVERVIEW_SKILLS) : group.skills).map(
                      (skill) => (
                        <SkillRow
                          key={skill.id}
                          skill={skill}
                          owner={botOf(skill.botId)}
                          busy={busy}
                          onOpen={() => setSelected({ kind: 'skill', id: skill.id })}
                          onToggle={(enabled) =>
                            void act(() => window.aelion.setSkillEnabled({ id: skill.id, enabled }))
                          }
                        />
                      ),
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}
          {nothing && (
            <div className="plugins-empty">
              <span>
                <Icon name={words ? 'search' : 'plugin'} size={24} />
              </span>
              <h2>{words ? t('没有找到相关插件') : t('暂无插件')}</h2>
              {words && (
                <button className="text-button" onClick={() => setQuery('')}>
                  {t('清除搜索')}
                </button>
              )}
            </div>
          )}
        </div>
      </section>
      <Presence>
        {selected?.kind === 'connector' ? (
          <ConnectorDetails
            key={selected.id}
            state={state}
            connector={connectors.find((connector) => connector.id === selected.id)}
            onClose={() => setSelected(undefined)}
            onOpenSession={onOpenSession}
          />
        ) : selected?.kind === 'sources' && state.integrations ? (
          <PluginDrawer label={t('来源与配置')} onClose={() => setSelected(undefined)}>
            <header className="plugin-hero">
              <span className="plugin-icon" style={{ width: 48, height: 48 }}>
                <Icon name="folder" size={24} />
              </span>
              <div>
                <h2>{t('来源与配置')}</h2>
                <p>{t('AelionBot 从这些位置读取技能和 MCP 配置')}</p>
              </div>
            </header>
            <div className="plugin-rows plugin-paths">
              <div>
                <span>
                  {t('共享技能')}
                  <code>{state.integrations.sharedSkillDir}</code>
                </span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void act(() => window.aelion.openIntegrationPath({ kind: 'shared-skills' }))}
                >
                  {t('打开目录')}
                </button>
              </div>
              <div>
                <span>
                  {t('MCP 配置')}
                  <code>{state.integrations.mcpFile}</code>
                </span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void act(() => window.aelion.openIntegrationPath({ kind: 'mcp-config' }))}
                >
                  {t('打开配置')}
                </button>
              </div>
            </div>
            <IntegrationSources sources={state.integrations.sources} busy={busy} act={act} />
          </PluginDrawer>
        ) : selected ? (
          <PluginDetails
            key={selected.kind + ':' + selected.id}
            skill={selected.kind === 'skill' ? skills.find((skill) => skill.id === selected.id) : undefined}
            server={selected.kind === 'mcp' ? servers.find((server) => server.id === selected.id) : undefined}
            owner={botOf(skills.find((skill) => skill.id === selected.id)?.botId)}
            sources={state.integrations?.sources || []}
            busy={busy}
            act={act}
            onClose={() => setSelected(undefined)}
          />
        ) : null}
      </Presence>
      <Presence>
        {connecting && (
          <AppConnectorDialog
            key={connecting.id}
            state={state}
            app={connecting}
            onClose={() => setConnecting(undefined)}
            onAdded={(id) => {
              setConnecting(undefined);
              setSelected({ kind: 'mcp', id });
            }}
          />
        )}
      </Presence>
      <Presence>
        {adding === 'mcp' && (
          <McpSnippetDialog
            busy={busy}
            onClose={() => setAdding(undefined)}
            onImport={(text) => window.aelion.importMcpSnippet(text)}
          />
        )}
      </Presence>
      <Presence>
        {adding && adding !== 'menu' && adding !== 'mcp' && (
          <AddConnectorDialog
            state={state}
            initialPlatform={adding}
            onClose={() => setAdding(undefined)}
            onCreated={(id) => {
              setAdding(undefined);
              setSelected({ kind: 'connector', id });
            }}
          />
        )}
      </Presence>
    </div>
  );
}
type Translate = ReturnType<typeof useI18n>['t'];
/** Built-in skills first, then each shared folder, then each Bot's private skills; most used first inside a group. */
function groupSkills(skills: Skill[], state: Snapshot, t: Translate): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const skill of skills) {
    const bot = skill.botId ? state.bots.find((item) => item.id === skill.botId) : undefined,
      builtin = !skill.botId && skill.source?.scope === 'builtin',
      key = skill.botId ? 'bot:' + skill.botId : builtin ? 'builtin' : 'source:' + (skill.source?.label || ''),
      label = skill.source?.label || '';
    if (!groups.has(key))
      groups.set(key, {
        key,
        title: skill.botId
          ? t('{name} 私有', { name: bot?.name || 'Bot' })
          : builtin
            ? t('内置')
            : t(label || '其他技能'),
        note: '',
        path: builtin || skill.botId ? undefined : state.integrations?.sources.find((s) => s.label === label)?.path,
        bot,
        skills: [],
      });
    groups.get(key)!.skills.push(skill);
  }
  const rank = (group: SkillGroup) => (group.key === 'builtin' ? 0 : group.bot ? 2 : 1);
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b))
    .map((group) => ({
      ...group,
      note: group.bot
        ? t('{count} 个，只有这个 Bot 能用', { count: group.skills.length })
        : t('{count} 个，所有 Bot 可用', { count: group.skills.length }),
      skills: group.skills.sort(
        (a, b) => (b.readCount || 0) - (a.readCount || 0) || a.name.localeCompare(b.name, 'zh-CN'),
      ),
    }));
}
function AddMenu({
  open,
  busy,
  onOpen,
  onPick,
}: {
  open: boolean;
  busy: boolean;
  onOpen: (open: boolean) => void;
  onPick: (kind: 'app' | 'connector' | 'mcp' | 'skills') => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const items = [
    { id: 'app', icon: 'globe', name: t('应用'), note: t('连接 Notion、GitHub、Google 等应用') },
    { id: 'connector', icon: 'message', name: t('消息渠道'), note: t('在飞书、企业微信或微信里和 Bot 对话') },
    { id: 'mcp', icon: 'plugin', name: t('MCP 服务'), note: t('粘贴配置，给 Bot 接上外部工具') },
    { id: 'skills', icon: 'book', name: t('技能文件夹'), note: t('从本地文件夹读取技能，所有 Bot 共享') },
  ] as const;
  return (
    <div className="plugins-add" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="secondary-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
      >
        <Icon name="plus" size={15} />
        {t('添加')}
        <Icon name="down" size={14} />
      </button>
      <Presence>
        {open && (
          <div
            className="plugins-add-menu"
            role="menu"
            aria-label={t('添加插件')}
            onKeyDown={(event) => {
              const controls = [...root.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]')],
                at = controls.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                controls[(at + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length]?.focus();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.id !== 'connector' && busy}
                onClick={() => onPick(item.id)}
              >
                <span>
                  <Icon name={item.icon} size={16} />
                </span>
                <strong>{item.name}</strong>
                <small>{item.note}</small>
              </button>
            ))}
          </div>
        )}
      </Presence>
    </div>
  );
}
/** One line of the catalog: a mark, a name with a line under it, and what can be done with it at the end. */
function PluginRow({
  mark,
  name,
  note,
  noteTitle,
  off = false,
  pluginId,
  onOpen,
  children,
}: {
  mark: ReactNode;
  name: ReactNode;
  note?: ReactNode;
  noteTitle?: string;
  off?: boolean;
  pluginId?: string;
  /** Makes the whole row open the item's details; controls in `children` stay above it. */
  onOpen?: () => void;
  children?: ReactNode;
}) {
  return (
    <article className={`plugin-row ${off ? 'is-off' : ''}`} data-plugin-id={pluginId}>
      {mark}
      <span className="plugin-row-text">
        {onOpen ? (
          <button type="button" className="plugin-open" onClick={onOpen}>
            {name}
          </button>
        ) : (
          <strong>{name}</strong>
        )}
        {note && <small title={noteTitle}>{note}</small>}
      </span>
      {children}
    </article>
  );
}
/** An app not added yet: its brand, what it is for, and the way to connect it. */
function CatalogRow({ app, busy, onConnect }: { app: AppConnector; busy: boolean; onConnect: () => void }) {
  const { t } = useI18n();
  const name = t(app.name);
  return (
    <PluginRow
      mark={
        <span className="connector-mark">
          <AppLogo app={app.id} size={22} />
        </span>
      }
      name={name}
      note={<span>{t(app.description)}</span>}
      noteTitle={t(app.description)}
    >
      <button
        type="button"
        className="secondary-button"
        aria-label={t('连接 {name}', { name })}
        disabled={busy}
        onClick={onConnect}
      >
        {t('去连接')}
      </button>
    </PluginRow>
  );
}
function ConnectorRow({
  connector,
  name,
  bot,
  sessions,
  onOpen,
  onToggle,
}: {
  connector: ConnectorView;
  /** Names the Bot too when the platform has several connectors; the note then leaves it out. */
  name: string;
  bot?: Bot;
  sessions: number;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const { t, language } = useI18n();
  const botInName = Boolean(bot) && name !== t(CONNECTOR_PLATFORM_NAMES[connector.platform]);
  return (
    <PluginRow
      pluginId={connector.id}
      mark={
        <span className="connector-mark">
          <ConnectorLogo platform={connector.platform} size={22} />
        </span>
      }
      name={name}
      note={
        <>
          <StatusDot status={connector.status} />
          <span>
            {t(connectorStatusText(connector.status))}
            {sessions > 0 && ' · ' + t('{count} 个会话', { count: sessions })}
            {bot && !botInName && ' · ' + bot.name}
          </span>
        </>
      }
      noteTitle={
        connector.account +
        (connector.lastMessageAt
          ? ' · ' + t('{time}有消息', { time: sinceText(connector.lastMessageAt, t, language) })
          : '')
      }
      onOpen={onOpen}
    >
      {connector.pairings.length > 0 && (
        <span className="plugin-badge">{t('{count} 个配对请求', { count: connector.pairings.length })}</span>
      )}
      <PluginSwitch name={name} enabled={connector.enabled} disabled={false} onChange={onToggle} />
    </PluginRow>
  );
}
/** An app from the catalog that was added: whether it works, and the sign-in button when it is not signed in. */
function AppRow({
  server,
  busy,
  act,
  onOpen,
  onSignIn,
}: {
  server: McpServerView;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  onOpen: () => void;
  onSignIn: () => void;
}) {
  const { t } = useI18n();
  const app = appOf(server),
    name = app ? t(app.name) : server.name,
    problem = server.status === 'needs-config' || server.status === 'error',
    status =
      t(mcpStatusText(server)) +
      (server.toolCount !== undefined ? ' · ' + t('{count} 个工具', { count: server.toolCount }) : '');
  return (
    <PluginRow
      pluginId={server.id}
      off={!server.enabled}
      mark={
        <span className="connector-mark">
          <AppLogo app={server.app} size={22} />
        </span>
      }
      name={name}
      note={
        <>
          <StatusDot status={server.login === 'signed-out' ? 'disabled' : server.status} />
          <span className={problem && server.login !== 'signed-out' ? 'is-problem' : undefined}>{status}</span>
        </>
      }
      noteTitle={status}
      onOpen={onOpen}
    >
      {server.login === 'signing-in' ? (
        <button type="button" className="text-button" onClick={() => void window.aelion.cancelMcpSignIn(server.id)}>
          {t('取消')}
        </button>
      ) : (
        server.login === 'signed-out' && (
          <button type="button" className="secondary-button" title={t('登录后 Bot 才能使用')} onClick={onSignIn}>
            {t('登录')}
          </button>
        )
      )}
      <PluginSwitch
        name={name}
        enabled={server.enabled}
        disabled={busy || server.status === 'connecting'}
        onChange={() => void act(() => window.aelion.setMcpEnabled({ id: server.id, enabled: !server.enabled }))}
      />
    </PluginRow>
  );
}
function McpRow({
  server,
  label,
  busy,
  act,
  onOpen,
  onSignIn,
}: {
  server: McpServerView;
  /** Shown instead of the name when the row sits inside a group of servers sharing that name. */
  label?: string;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  onOpen: () => void;
  onSignIn: () => void;
}) {
  const { t } = useI18n();
  const problem = server.status === 'needs-config' || server.status === 'error';
  return (
    <div className={`mcp-row ${server.enabled ? '' : 'is-off'}`} data-plugin-id={server.id}>
      <PluginIcon server={server} size={36} />
      <div className="mcp-row-main">
        <button type="button" className="plugin-open" onClick={onOpen}>
          {label || server.name}
        </button>
        <p className={problem ? 'is-problem' : undefined}>
          <StatusDot status={server.status} />
          <span title={problem ? server.issue : undefined}>
            {t(mcpStatusText(server))}
            {problem && server.issue ? '：' + server.issue : ''}
          </span>
          {server.toolCount !== undefined && <span>· {t('{count} 个工具', { count: server.toolCount })}</span>}
          <span>· {server.transport === 'unsupported' ? t('不支持的连接方式') : server.transport.toUpperCase()}</span>
          {!label && <span>· {t('来自 {source}', { source: t(server.source.label) })}</span>}
        </p>
      </div>
      {server.login === 'signed-out' ? (
        <button type="button" className="text-button" onClick={onSignIn}>
          {t('登录')}
        </button>
      ) : (
        problem && (
          <button type="button" className="text-button" onClick={onOpen}>
            {server.status === 'needs-config' ? t('去配置') : t('查看')}
          </button>
        )
      )}
      <PluginSwitch
        name={server.name}
        enabled={server.enabled}
        disabled={busy || server.status === 'connecting' || (!server.enabled && server.status === 'needs-config')}
        onChange={() => void act(() => window.aelion.setMcpEnabled({ id: server.id, enabled: !server.enabled }))}
      />
    </div>
  );
}
/** Servers with the same name from several config files, one row each once opened. */
function McpGroup({
  servers,
  open,
  onToggle,
  busy,
  act,
  onSignIn,
  onOpen,
}: {
  servers: McpServerView[];
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  onSignIn: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const on = servers.filter((server) => server.enabled).length,
    best =
      servers.find((server) => server.status === 'connected') ||
      servers.find((server) => server.status === 'error' || server.status === 'needs-config') ||
      servers[0];
  return (
    <div className={`mcp-group ${open ? 'is-open' : ''}`}>
      <button type="button" className={`mcp-row ${on ? '' : 'is-off'}`} aria-expanded={open} onClick={onToggle}>
        <PluginIcon server={servers[0]} size={36} />
        <span className="mcp-row-main">
          <strong>
            {servers[0].name}
            <span className="plugin-tag">{t('{count} 个来源', { count: servers.length })}</span>
          </strong>
          <span className="mcp-row-line">
            <StatusDot status={best.status} />
            <span>{on ? t('{count} 个已启用', { count: on }) : t('未启用')}</span>
            {servers.map((server) => (
              <span className="plugin-chip" key={server.id}>
                {t(server.source.label)}
              </span>
            ))}
          </span>
        </span>
        <Icon name="down" size={16} />
      </button>
      {open &&
        servers.map((server) => (
          <McpRow
            key={server.id}
            server={server}
            label={t(server.source.label)}
            busy={busy}
            act={act}
            onSignIn={() => onSignIn(server.id)}
            onOpen={() => onOpen(server.id)}
          />
        ))}
    </div>
  );
}
function SkillRow({
  skill,
  owner,
  busy,
  onOpen,
  onToggle,
}: {
  skill: Skill;
  owner?: Bot;
  busy: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const enabled = skill.enabled ?? !skill.archived;
  return (
    <PluginRow
      pluginId={skill.id}
      off={!enabled}
      mark={<PluginIcon skill={skill} owner={owner} size={36} />}
      name={skill.name}
      note={<span>{skill.description}</span>}
      noteTitle={skill.description}
      onOpen={onOpen}
    >
      <PluginSwitch name={skill.name} enabled={enabled} disabled={busy} onChange={() => onToggle(!enabled)} />
    </PluginRow>
  );
}
