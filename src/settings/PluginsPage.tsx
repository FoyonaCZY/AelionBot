import { useEffect, useRef, useState } from 'react';
import type { Bot, McpServerView, Skill, Snapshot, WorkSession } from '../../shared/types/core';
import {
  CONNECTOR_PLATFORM_NAMES,
  type ConnectorPlatform,
  type ConnectorView,
} from '../../shared/types/connector-types';
import { IntegrationSources, McpSnippetDialog } from './IntegrationSettings';
import { PluginDetails, PluginDrawer, PluginSwitch, StatusDot } from './PluginDetails';
import { AddConnectorDialog, connectorStatusText } from './AddConnectorDialog';
import { ConnectorDetails } from './ConnectorDetails';
import { ConnectorLogo } from './ConnectorLogo';
import { AppConnectorDialog } from './AppConnectorDialog';
import { AppLogo } from './AppLogo';
import { APP_CONNECTORS } from '../../shared/app-connectors';
import { PluginIcon, mcpStatusText, sinceText } from './plugin-visuals';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import './plugins.css';
export type PluginFilter = 'all' | 'skills' | 'mcp' | 'connectors';
type Selected = { kind: 'skill' | 'mcp' | 'connector' | 'sources'; id: string };
type SkillGroup = { key: string; title: string; note: string; path?: string; bot?: Bot; skills: Skill[] };
const PLATFORMS: ConnectorPlatform[] = ['feishu', 'wecom', 'weixin'];
/** Apps shown on the empty "apps" card, to say what kind of thing can be connected. */
const FEATURED_APPS = ['notion', 'github', 'gmail', 'linear', 'supabase', 'figma-desktop'];
const appOf = (server: McpServerView) => APP_CONNECTORS.find((app) => app.id === server.app);
/** How many skills of a group the overview shows before "show more". */
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
  const { t, language } = useI18n();
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState<PluginFilter>(initialFilter),
    [selected, setSelected] = useState<Selected>(),
    [adding, setAdding] = useState<'menu' | 'mcp' | 'app' | ConnectorPlatform>(),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [connectorError, setConnectorError] = useState(''),
    [appError, setAppError] = useState(''),
    heading = useRef<HTMLHeadingElement>(null),
    search = useRef<HTMLInputElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
  const tabs: Array<{ id: PluginFilter; name: string; count?: number }> = [
    { id: 'all', name: t('概览') },
    { id: 'skills', name: t('技能'), count: skills.length },
    { id: 'connectors', name: t('连接器'), count: apps.length + connectors.length },
    { id: 'mcp', name: 'MCP', count: plainServers.length },
  ];
  const show = (kind: PluginFilter) => filter === 'all' || filter === kind,
    nothing =
      (!show('skills') || !shownSkills.length) &&
      (!show('mcp') || !shownServers.length) &&
      (!show('connectors') || (!shownConnectors.length && !shownApps.length)),
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
    <main className="plugins-page" aria-labelledby="plugins-heading">
      <div className="plugins-content">
        <header className="plugins-header drag">
          <div className="plugins-title">
            <h1 id="plugins-heading" ref={heading} tabIndex={-1}>
              {t('插件')}
            </h1>
            <p>{t('给 Bot 加技能、接上外部工具，或者让它在飞书和微信里收消息。')}</p>
          </div>
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
            {!query && <kbd>Ctrl K</kbd>}
          </label>
          <AddMenu
            open={adding === 'menu'}
            busy={busy}
            onOpen={(open) => setAdding(open ? 'menu' : undefined)}
            onPick={(kind) => {
              if (kind === 'skills') {
                setAdding(undefined);
                void act(() => window.aelion.addIntegrationSource('skills'));
              } else setAdding(kind === 'mcp' ? 'mcp' : kind === 'app' ? 'app' : 'feishu');
            }}
          />
          <button className="icon-button" aria-label={t('返回聊天')} onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </header>
        <nav className="plugins-tabs" aria-label={t('插件分类')}>
          {tabs.map((tab) => (
            <button key={tab.id} type="button" aria-current={filter === tab.id} onClick={() => setFilter(tab.id)}>
              {tab.name}
              {tab.count !== undefined && <span>{tab.count}</span>}
            </button>
          ))}
          <span className="plugins-tabs-spacer" />
          {state.integrations && (
            <button type="button" className="plugins-tab-link" onClick={() => setSelected({ kind: 'sources', id: '' })}>
              <Icon name="folder" size={15} />
              {t('来源与配置')}
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
        {show('connectors') && (shownApps.length > 0 || !words) && (
          <section className="plugins-section" aria-labelledby="plugins-apps-title">
            <div className="plugins-section-head">
              <h2 id="plugins-apps-title">{t('应用')}</h2>
              <span>{t('让 Bot 读写 Notion、GitHub、Google 等应用里的内容')}</span>
            </div>
            {appError && (
              <p className="computer-notice" role="alert">
                {appError}
              </p>
            )}
            <div className="connector-grid">
              {shownApps.map((server) => (
                <AppCard
                  key={server.id}
                  server={server}
                  busy={busy}
                  act={act}
                  onSignIn={() => signIn(server.id)}
                  onOpen={() => setSelected({ kind: 'mcp', id: server.id })}
                />
              ))}
              {!words && (
                <button
                  type="button"
                  className="connector-card is-add"
                  disabled={busy}
                  onClick={() => setAdding('app')}
                >
                  <span className="connector-add-logos">
                    {FEATURED_APPS.slice(0, apps.length ? 3 : 6).map((app) => (
                      <span className="connector-mark is-small" key={app}>
                        <AppLogo app={app} size={14} />
                      </span>
                    ))}
                  </span>
                  <strong>{t('连接应用')}</strong>
                  <small>{t('{count} 个应用可选', { count: APP_CONNECTORS.length })}</small>
                </button>
              )}
            </div>
          </section>
        )}
        {show('connectors') && (shownConnectors.length > 0 || !words) && (
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
            </div>
            {connectorError && (
              <p className="computer-notice" role="alert">
                {connectorError}
              </p>
            )}
            {connectors.length === 0 ? (
              <div className="connector-empty">
                <div>
                  <strong>{t('在飞书、企业微信或微信里和 Bot 对话')}</strong>
                  <p>
                    {t(
                      '连接后，私聊消息会交给 Bot 在这台电脑上处理；企业微信群里 @ 它的消息也可以。做完把结果和文件发回去，不需要公网地址。',
                    )}
                  </p>
                </div>
                <div className="connector-empty-platforms">
                  {PLATFORMS.map((platform) => (
                    <button
                      key={platform}
                      type="button"
                      className="secondary-button"
                      onClick={() => setAdding(platform)}
                    >
                      <span className="connector-mark is-small">
                        <ConnectorLogo platform={platform} size={14} />
                      </span>
                      {t(CONNECTOR_PLATFORM_NAMES[platform])}
                      {platform === 'weixin' && <span className="plugin-tag">{t('实验')}</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="connector-grid">
                {shownConnectors.map((connector) => (
                  <ConnectorCard
                    key={connector.id}
                    connector={connector}
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
                {!words && (
                  <button type="button" className="connector-card is-add" onClick={() => setAdding('feishu')}>
                    <span className="connector-add-logos">
                      {PLATFORMS.map((platform) => (
                        <span className="connector-mark is-small" key={platform}>
                          <ConnectorLogo platform={platform} size={14} />
                        </span>
                      ))}
                    </span>
                    <strong>{t('添加消息渠道')}</strong>
                    <small>{t('飞书、企业微信或微信')}</small>
                  </button>
                )}
              </div>
            )}
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
            </div>
            {skillGroups.map((group) => {
              const limit = filter === 'all' && !words && !expanded.has('skills:' + group.key),
                visible = limit ? group.skills.slice(0, OVERVIEW_SKILLS) : group.skills,
                hidden = group.skills.length - OVERVIEW_SKILLS;
              return (
                <div className="skill-group" key={group.key}>
                  <h3>
                    <strong>{group.title}</strong>
                    {group.bot && <Avatar bot={group.bot} size={16} />}
                    <span>{group.note}</span>
                    {group.path && <code title={group.path}>{group.path}</code>}
                  </h3>
                  <div className="skill-grid">
                    {visible.map((skill) => (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        owner={botOf(skill.botId)}
                        busy={busy}
                        since={(iso) => sinceText(iso, t, language)}
                        onOpen={() => setSelected({ kind: 'skill', id: skill.id })}
                        onToggle={(enabled) => void act(() => window.aelion.setSkillEnabled({ id: skill.id, enabled }))}
                      />
                    ))}
                  </div>
                  {filter === 'all' && !words && hidden > 0 && (
                    <button
                      type="button"
                      className="plugins-more"
                      onClick={() => toggleExpanded('skills:' + group.key)}
                    >
                      {limit ? t('再显示 {count} 个', { count: hidden }) : t('收起')}
                      <Icon name="down" size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        )}
        {nothing && (filter !== 'connectors' || words) && (
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
      {adding === 'app' && (
        <AppConnectorDialog
          state={state}
          onClose={() => setAdding(undefined)}
          onAdded={(id) => {
            setAdding(undefined);
            setSelected({ kind: 'mcp', id });
          }}
        />
      )}
      {adding === 'mcp' && (
        <McpSnippetDialog
          busy={busy}
          onClose={() => setAdding(undefined)}
          onImport={(text) => window.aelion.importMcpSnippet(text)}
        />
      )}
      {adding && adding !== 'menu' && adding !== 'mcp' && adding !== 'app' && (
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
    </main>
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
        className="primary-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
      >
        <Icon name="plus" size={15} />
        {t('添加')}
        <Icon name="down" size={14} />
      </button>
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
    </div>
  );
}
function ConnectorCard({
  connector,
  bot,
  sessions,
  onOpen,
  onToggle,
}: {
  connector: ConnectorView;
  bot?: Bot;
  sessions: number;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const { t, language } = useI18n();
  const name = t(CONNECTOR_PLATFORM_NAMES[connector.platform]);
  return (
    <article className="connector-card" data-plugin-id={connector.id}>
      <div className="connector-card-top">
        <span className="connector-mark">
          <ConnectorLogo platform={connector.platform} size={22} />
        </span>
        <span className="connector-card-name">
          <button type="button" className="plugin-open" onClick={onOpen}>
            {name}
          </button>
          <small title={connector.account}>{connector.account}</small>
        </span>
        <PluginSwitch name={name} enabled={connector.enabled} disabled={false} onChange={onToggle} />
      </div>
      <p className="connector-card-state">
        <StatusDot status={connector.status} />
        <span>
          {t(connectorStatusText(connector.status))}
          {sessions > 0 && ' · ' + t('{count} 个会话', { count: sessions })}
        </span>
        {connector.pairings.length > 0 && (
          <span className="plugin-badge">{t('{count} 个配对请求', { count: connector.pairings.length })}</span>
        )}
      </p>
      <div className="connector-card-foot">
        {bot && <Avatar bot={bot} size={18} />}
        <span>{bot?.name}</span>
        <span className="plugins-tabs-spacer" />
        {connector.lastMessageAt && (
          <time dateTime={connector.lastMessageAt}>
            {t('{time}有消息', { time: sinceText(connector.lastMessageAt, t, language) })}
          </time>
        )}
      </div>
    </article>
  );
}
/** An app from the catalog: its brand, whether it is signed in, and the sign-in button when it is not. */
function AppCard({
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
    problem = server.status === 'needs-config' || server.status === 'error';
  return (
    <article className={`connector-card app-card ${server.enabled ? '' : 'is-off'}`} data-plugin-id={server.id}>
      <div className="connector-card-top">
        <span className="connector-mark">
          <AppLogo app={server.app} size={22} />
        </span>
        <span className="connector-card-name">
          <button type="button" className="plugin-open" onClick={onOpen}>
            {name}
          </button>
          {app && <small title={t(app.description)}>{t(app.description)}</small>}
        </span>
        <PluginSwitch
          name={name}
          enabled={server.enabled}
          disabled={busy || server.status === 'connecting'}
          onChange={() => void act(() => window.aelion.setMcpEnabled({ id: server.id, enabled: !server.enabled }))}
        />
      </div>
      <p className={`connector-card-state ${problem && server.login !== 'signed-out' ? 'is-problem' : ''}`}>
        <StatusDot status={server.login === 'signed-out' ? 'disabled' : server.status} />
        <span>
          {t(mcpStatusText(server))}
          {server.toolCount !== undefined && ' · ' + t('{count} 个工具', { count: server.toolCount })}
        </span>
      </p>
      <div className="connector-card-foot">
        {server.login === 'signing-in' ? (
          <>
            <span>{t('在浏览器里完成登录')}</span>
            <span className="plugins-tabs-spacer" />
            <button type="button" className="text-button" onClick={() => void window.aelion.cancelMcpSignIn(server.id)}>
              {t('取消')}
            </button>
          </>
        ) : server.login === 'signed-out' ? (
          <>
            <span>{t('登录后 Bot 才能使用')}</span>
            <span className="plugins-tabs-spacer" />
            <button type="button" className="secondary-button" onClick={onSignIn}>
              {t('登录')}
            </button>
          </>
        ) : (
          <span>{server.login === 'signed-in' ? t('已登录') : app?.local ? t('在这台电脑上运行') : t('无需登录')}</span>
        )}
      </div>
    </article>
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
      <PluginIcon server={server} />
      <div className="mcp-row-main">
        <button type="button" className="plugin-open" onClick={onOpen}>
          {label || server.name}
        </button>
        <p className={problem ? 'is-problem' : undefined}>
          <StatusDot status={server.status} />
          <span>
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
        <PluginIcon server={servers[0]} />
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
function SkillCard({
  skill,
  owner,
  busy,
  since,
  onOpen,
  onToggle,
}: {
  skill: Skill;
  owner?: Bot;
  busy: boolean;
  since: (iso: string) => string;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const enabled = skill.enabled ?? !skill.archived;
  return (
    <article className={`skill-card ${enabled ? '' : 'is-off'}`} data-plugin-id={skill.id}>
      <PluginIcon skill={skill} owner={owner} />
      <button type="button" className="plugin-open" title={skill.name} onClick={onOpen}>
        {skill.name}
      </button>
      <PluginSwitch name={skill.name} enabled={enabled} disabled={busy} onChange={() => onToggle(!enabled)} />
      <p title={skill.description}>{skill.description}</p>
      <small>
        {!enabled
          ? t('已停用')
          : skill.readCount
            ? t('用过 {count} 次', { count: skill.readCount }) +
              (skill.lastReadAt ? ' · ' + since(skill.lastReadAt) : '')
            : t('还没用过')}
      </small>
    </article>
  );
}
