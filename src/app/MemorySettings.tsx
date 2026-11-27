import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import type {
  MemoryEpisode,
  MemoryItem,
  MemoryItemDetail,
  MemoryKind,
  MemoryOrigin,
  MemoryOverview,
} from '../../shared/types/memory-types';
import { ModelSelectionFields, validModelSelection } from '../settings/ModelSelectionFields';
import { ProfileAvatar, SettingsSection, SettingsEmpty } from '../settings/SettingsWindow';
import { Avatar } from '../ui/Avatar';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
import { useCollapse } from '../ui/use-collapse';
import { useI18n } from '../i18n';
import './memory-settings.css';

const KINDS: Record<MemoryKind, string> = {
  preference: '偏好',
  profile: '个人信息',
  environment: '环境',
  project: '项目',
  decision: '决定',
  lesson: '经验',
  event: '安排',
  commitment: '约定',
};
const ORIGINS: Record<MemoryOrigin, string> = {
  user_explicit: '你要求记住的',
  user_stated: '你说过的',
  tool_verified: '工具核实的',
  model_inferred: 'Bot 推断的',
};
const JOB_STATUS: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已让路',
  undone: '已撤销',
};
const ACTIONS: Record<string, string> = {
  create: '记下',
  edit: '你修改了',
  supersede: '被取代',
  merge: '合并',
  split: '拆分',
  archive: '归档',
  expire: '过期',
  confirm: '再次提到',
  'confirm-user': '你确认了',
  promote: '多次印证后启用',
  suggest: '建议调整范围',
  decline: '你拒绝了建议',
  undo: '撤销',
  rank: '调整顺序',
  forget: '遗忘',
};
/** The two parts of the page: what is remembered, and how remembering works. */
const PAGES = [
  { id: 'items', label: '记忆' },
  { id: 'settings', label: '设置' },
] as const;
export type MemoryPage = (typeof PAGES)[number]['id'];
type BotOptions = { shareUser: boolean; mode: 'on' | 'read' | 'off' };

const day = (value: string, language: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium' });
const moment = (value: string, language: string) =>
  new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

function Switch({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      className={on ? 'learning-switch enabled' : 'learning-switch'}
      disabled={disabled}
      onClick={onChange}
    >
      <i />
    </button>
  );
}

/** Whose memory it is, as a face: you, a Bot, or a line icon for a project or a group. */
function ScopeFace({ scope, bots, name, size }: { scope: string; bots: Bot[]; name?: string; size: number }) {
  if (scope === 'user') return <ProfileAvatar name={name} size={size} />;
  const bot = scope.startsWith('bot:') ? bots.find((item) => item.id === scope.slice(4)) : undefined;
  if (bot) return <Avatar bot={bot} size={size} />;
  return (
    <span className="memory-scope-icon" aria-hidden="true">
      <Icon
        name={scope.startsWith('bot:') ? 'bot' : scope.startsWith('group:') ? 'message' : 'folder'}
        size={Math.max(12, Math.round(size * 0.6))}
      />
    </span>
  );
}

function MemoryRow({
  item,
  pending,
  scope,
  busy,
  run,
}: {
  item: MemoryItem & { suggest?: { scope?: string; reason?: string } };
  pending?: boolean;
  /** Where it belongs, shown on the rows that wait for the user because they come from every scope. */
  scope?: ReactNode;
  busy: boolean;
  run: (operation: () => Promise<unknown>) => void;
}) {
  const { t, language } = useI18n();
  const [editing, setEditing] = useState<string>(),
    [expanded, setExpanded] = useState(false),
    [detail, setDetail] = useState<MemoryItemDetail>(),
    [detailFailed, setDetailFailed] = useState(false);
  const fold = useCollapse(expanded);
  const loadDetail = () => {
    setDetailFailed(false);
    void window.aelion.memoryDetail(item.id).then(setDetail, () => setDetailFailed(true));
  };
  const archived = item.status === 'archived';
  const facts = (
    <>
      <span>{t(ORIGINS[item.origin])}</span>
      <span>{day(item.recordedAt, language)}</span>
    </>
  );
  return (
    <li
      className={`memory-row${pending ? ' is-pending' : ''}${archived ? ' is-archived' : ''}${expanded ? ' is-open' : ''}`}
    >
      <div className="memory-row-main">
        <div className="memory-row-copy">
          {editing === undefined ? (
            <p className="memory-text">{item.text}</p>
          ) : (
            <textarea
              aria-label={t('记忆内容')}
              value={editing}
              disabled={busy}
              maxLength={600}
              autoFocus
              onChange={(event) => setEditing(event.target.value)}
            />
          )}
          {editing === undefined ? (
            <div className="memory-meta">
              {item.pinned && (
                <span className="memory-chip is-pinned">
                  <Icon name="pin" size={11} />
                  {t('已置顶')}
                </span>
              )}
              {scope}
              <span className="memory-chip">{t(KINDS[item.kind])}</span>
              {pending ? (
                <>
                  {item.note && <span>{item.note}</span>}
                  {item.suggest?.reason && <span>{item.suggest.reason}</span>}
                </>
              ) : (
                facts
              )}
              {item.sensitivity === 'private' && (
                <span className="memory-flag">
                  <Icon name="lock" size={11} />
                  {t('私密')}
                </span>
              )}
              {archived && <span>{t('已归档')}</span>}
            </div>
          ) : (
            <div className="memory-row-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(undefined)}>
                {t('取消')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !editing.trim()}
                onClick={() => {
                  const text = editing.trim();
                  run(async () => {
                    await window.aelion.memoryUpdate({ id: item.id, text });
                    setEditing(undefined);
                    setDetail(undefined);
                    setExpanded(false);
                  });
                }}
              >
                {t('保存')}
              </button>
            </div>
          )}
        </div>
        {editing === undefined && (
          <div className="memory-row-side">
            {pending ? (
              <div className="memory-row-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => run(() => window.aelion.memoryReject(item.id))}
                >
                  {item.status === 'candidate' ? t('不要记') : t('保持原样')}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => run(() => window.aelion.memoryConfirm(item.id))}
                >
                  {item.suggest?.scope === 'user' ? t('让所有 Bot 知道') : t('确认')}
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="icon-button memory-pin is-quiet"
                  title={item.pinned ? t('取消置顶') : t('置顶')}
                  aria-label={item.pinned ? t('取消置顶') : t('置顶')}
                  aria-pressed={item.pinned}
                  disabled={busy}
                  onClick={() => run(() => window.aelion.memoryUpdate({ id: item.id, pinned: !item.pinned }))}
                >
                  <Icon name="pin" size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button is-quiet"
                  title={t('修改')}
                  aria-label={t('修改')}
                  disabled={busy}
                  onClick={() => setEditing(item.text)}
                >
                  <Icon name="edit" size={15} />
                </button>
              </>
            )}
            <button
              type="button"
              className="icon-button memory-expand"
              title={t('记忆详情')}
              aria-label={t('记忆详情')}
              aria-expanded={expanded}
              onClick={() => {
                setExpanded(!expanded);
                if (!expanded && !detail) loadDetail();
              }}
            >
              <Icon name="chevron" size={15} />
            </button>
          </div>
        )}
      </div>
      {fold.mounted && (
        <div className="ui-collapse" data-closing={fold.closing || undefined}>
          <div>
            <div className="memory-detail">
              {!pending && item.note && <p className="memory-note">{item.note}</p>}
              <div className="memory-detail-head">
                <strong>{t('为什么记得')}</strong>
                <div className="memory-meta">
                  {pending && facts}
                  {item.speaker && <span>{t('来自 {name}', { name: item.speaker })}</span>}
                  {item.recallCount > 0 && <span>{t('想起过 {count} 次', { count: item.recallCount })}</span>}
                </div>
              </div>
              {detailFailed ? (
                <p role="alert" className="memory-detail-state">
                  {t('记忆详情加载失败')}
                  <button type="button" className="text-button" onClick={loadDetail}>
                    {t('重试')}
                  </button>
                </p>
              ) : !detail ? (
                <p role="status" className="memory-detail-state">
                  {t('加载中…')}
                </p>
              ) : (
                <>
                  {detail.sources.length ? (
                    detail.sources.map((source, index) => (
                      <blockquote key={index} className={source.available ? undefined : 'is-missing'}>
                        {source.available ? source.excerpt : t('原始消息已不存在')}
                        {source.at && <cite>{moment(source.at, language)}</cite>}
                      </blockquote>
                    ))
                  ) : (
                    <p className="memory-detail-state">{t('没有记录来源')}</p>
                  )}
                  {detail.history.length > 0 && (
                    <ol className="memory-history">
                      {detail.history.map((event) => (
                        <li key={event.id}>
                          <span>{ACTIONS[event.action] ? t(ACTIONS[event.action]) : event.action}</span>
                          <time>{moment(event.at, language)}</time>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
              {!pending && (
                <div className="memory-row-actions">
                  <button
                    type="button"
                    className="secondary-button danger-text"
                    disabled={busy}
                    onClick={() => run(() => window.aelion.memoryForget(item.id))}
                  >
                    {t('忘记')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/** The Memory settings tab: what each Bot remembers, what waits for the user, and how the background work went. */
export function MemorySettings({
  state,
  bot,
  scope,
  onScope,
  initialPage = 'items',
  busy,
  act,
}: {
  state: Snapshot;
  bot?: Bot;
  scope: string;
  onScope: (id: string) => void;
  /** The part to open on: another page links straight to the settings here. */
  initialPage?: MemoryPage;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const { t, language } = useI18n();
  const scopeBot = state.bots.find((item) => item.id === scope) || bot || state.bots[0];
  const [page, setPage] = useState<MemoryPage>(initialPage),
    [area, setArea] = useState<string>(),
    [pane, setPane] = useState<'facts' | 'episodes'>('facts'),
    [overview, setOverview] = useState<MemoryOverview>(),
    [items, setItems] = useState<MemoryItem[]>([]),
    [pending, setPending] = useState<MemoryItem[]>([]),
    [timeline, setTimeline] = useState<MemoryEpisode[]>(),
    [timelineFailed, setTimelineFailed] = useState(false),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true),
    [loadFailed, setLoadFailed] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [options, setOptions] = useState<BotOptions>(),
    [past, setPast] = useState<{ conversations: number; inputTokens: number }>();
  const selected = area || (scopeBot ? 'bot:' + scopeBot.id : 'user');
  const view = JSON.stringify([selected, query, showArchived]),
    currentView = useRef(view),
    refreshVersion = useRef(0);
  currentView.current = view;
  const root = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null);
  useSwitchMotion(root, page, ':scope > :not([hidden], .memory-topbar)');
  useSwitchMotion(body, selected + pane);
  const learning = state.cognition?.learning;
  const refresh = useCallback(async () => {
    if (currentView.current !== view) return;
    const version = ++refreshVersion.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [nextOverview, nextItems, nextPending] = await Promise.all([
        window.aelion.memoryOverview(),
        window.aelion.memoryList({
          scope: selected,
          status: showArchived ? 'all' : 'active',
          ...(query.trim() ? { query } : {}),
        }),
        window.aelion.memoryList({ status: 'pending' }),
      ]);
      if (version !== refreshVersion.current || currentView.current !== view) return;
      setOverview(nextOverview);
      setItems(nextItems.filter((item) => item.status !== 'candidate'));
      setPending(nextPending);
    } catch {
      if (version === refreshVersion.current && currentView.current === view) setLoadFailed(true);
    } finally {
      if (version === refreshVersion.current && currentView.current === view) setLoading(false);
    }
  }, [selected, query, showArchived, view]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh, state.cognition?.learning.working]);
  // The download reports its progress here.
  useEffect(() => {
    if (overview?.embedding.state !== 'downloading') return;
    const timer = setInterval(() => void refresh().catch(() => {}), 1500);
    return () => clearInterval(timer);
  }, [overview?.embedding.state, refresh]);
  const selectedBot = selected.startsWith('bot:') ? selected.slice(4) : undefined,
    currentBot = useRef(selectedBot);
  currentBot.current = selectedBot;
  useEffect(() => {
    setOptions(undefined);
    setTimeline(undefined);
    setTimelineFailed(false);
    setPane('facts');
    let active = true;
    if (selectedBot)
      void window.aelion.memoryBotOptions(selectedBot).then(
        (next) => {
          if (active) setOptions(next);
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, [selectedBot]);
  const run = (operation: () => Promise<unknown>) => void act(operation).then(() => refresh().catch(() => {}));
  const choose = (next: string) => {
    if (next === selected) return;
    setItems([]);
    setLoading(true);
    setQuery('');
    setArea(next);
    if (next.startsWith('bot:')) onScope(next.slice(4));
  };
  const loadTimeline = (botId: string) => {
    setTimelineFailed(false);
    void window.aelion.memoryTimeline({ botId, limit: 40 }).then(
      (next) => {
        if (currentBot.current === botId) setTimeline(next);
      },
      () => {
        if (currentBot.current === botId) setTimelineFailed(true);
      },
    );
  };
  const setBotOptions = (botId: string, patch: Partial<BotOptions>) =>
    run(async () => {
      await window.aelion.memorySetBotOptions({ botId, ...patch });
      if (currentBot.current === botId) setOptions((current) => current && { ...current, ...patch });
    });
  const countOf = (id: string) => overview?.scopes.find((item) => item.scope === id)?.count || 0,
    labelOf = (id: string) =>
      id === 'user'
        ? t('关于你')
        : state.bots.find((item) => 'bot:' + item.id === id)?.name ||
          overview?.scopes.find((item) => item.scope === id)?.label ||
          id;
  const scopes = [
    'user',
    ...state.bots.map((item) => 'bot:' + item.id),
    ...(overview?.scopes.filter((item) => item.kind === 'project' || item.kind === 'group') || []).map(
      (item) => item.scope,
    ),
  ];
  const face = (id: string, size: number) => (
    <ScopeFace scope={id} bots={state.bots} name={state.userProfile?.displayName} size={size} />
  );
  const embedding = overview?.embedding,
    providers = state.providers || [],
    jobs = overview?.jobs.filter((job) => job.kind === 'consolidate').slice(0, 8) || [],
    summary = [
      ...(countOf(selected) ? [t('{count} 条记忆', { count: countOf(selected) })] : []),
      ...(selected === 'user' ? [t('所有 Bot 共用')] : []),
    ].join(' · ');
  const status = !learning
    ? undefined
    : !learning.enabled
      ? { tone: 'is-paused', text: t('自动记忆已暂停') }
      : learning.runningBotId || learning.working
        ? { tone: 'is-working', text: t('正在整理经验') }
        : learning.queued > 0
          ? { tone: 'is-working', text: t('{count} 项等待整理', { count: learning.queued }) }
          : { tone: 'is-ready', text: t('自动记忆已开启') };
  return (
    <div ref={root} className="memory-page">
      <div className="memory-topbar">
        <div className="memory-tabs" role="group" aria-label={t('记忆')}>
          {PAGES.map((item) => (
            <button key={item.id} type="button" aria-pressed={page === item.id} onClick={() => setPage(item.id)}>
              <Icon name={item.id === 'items' ? 'memory' : 'sliders'} size={16} />
              {t(item.label)}
            </button>
          ))}
        </div>
        {status && (
          <span className={`memory-status ${status.tone}`} role="status">
            {status.text}
          </span>
        )}
      </div>
      <div hidden={page !== 'items'}>
        {pending.length > 0 && (
          <details className="settings-card memory-inbox" open={pending.length <= 3}>
            <summary>
              <span>{t('等你确认')}</span>
              <small className="memory-count">{pending.length}</small>
            </summary>
            <ul className="memory-rows">
              {pending.map((item) => (
                <MemoryRow
                  key={item.id}
                  item={item}
                  scope={
                    <span className="memory-chip is-scope">
                      {face(item.scope, 14)}
                      {labelOf(item.scope)}
                    </span>
                  }
                  pending
                  busy={busy}
                  run={run}
                />
              ))}
            </ul>
          </details>
        )}
        <div className="memory-scopes" role="group" aria-label={t('选择范围')}>
          {scopes.map((id) => (
            <button
              key={id}
              type="button"
              title={labelOf(id)}
              aria-pressed={selected === id}
              onClick={() => choose(id)}
            >
              {face(id, 22)}
              <span>{labelOf(id)}</span>
              {countOf(id) > 0 && <small>{countOf(id)}</small>}
            </button>
          ))}
        </div>
        <section className="settings-card memory-panel" aria-label={labelOf(selected)}>
          <header className="memory-scope-head">
            {face(selected, 36)}
            <div className="memory-scope-title">
              <strong>{labelOf(selected)}</strong>
              {summary && <small>{summary}</small>}
            </div>
            {selectedBot && options && (
              <div className="memory-scope-options">
                <label className="memory-share">
                  {t('使用关于你的记忆')}
                  <Switch
                    label={t('使用关于你的记忆')}
                    on={options.shareUser}
                    disabled={busy}
                    onChange={() => setBotOptions(selectedBot, { shareUser: !options.shareUser })}
                  />
                </label>
                <Select
                  className="settings-select"
                  aria-label={t('记忆方式')}
                  title={t('记忆方式')}
                  value={options.mode}
                  disabled={busy}
                  onChange={(event) => setBotOptions(selectedBot, { mode: event.target.value as BotOptions['mode'] })}
                >
                  <option value="on">{t('使用并记住')}</option>
                  <option value="read">{t('只用，不记新的')}</option>
                  <option value="off">{t('不使用')}</option>
                </Select>
              </div>
            )}
          </header>
          <div className="memory-toolbar">
            {selectedBot && (
              <div className="memory-views" role="group" aria-label={labelOf(selected)}>
                <button type="button" aria-pressed={pane === 'facts'} onClick={() => setPane('facts')}>
                  {t('已有记忆')}
                </button>
                <button
                  type="button"
                  aria-pressed={pane === 'episodes'}
                  onClick={() => {
                    setPane('episodes');
                    if (!timeline) loadTimeline(selectedBot);
                  }}
                >
                  {t('做过的事')}
                </button>
              </div>
            )}
            {pane === 'facts' && (
              <>
                <label className="memory-search">
                  <Icon name="search" size={16} />
                  <input
                    type="search"
                    aria-label={t('搜索记忆')}
                    placeholder={t('搜索记忆')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="memory-filter"
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived(!showArchived)}
                >
                  <Icon name="archive" size={15} />
                  {t('显示已归档')}
                </button>
              </>
            )}
          </div>
          <div ref={body} className="memory-panel-body">
            {pane === 'episodes' && selectedBot ? (
              timelineFailed ? (
                <p role="alert" className="memory-panel-state">
                  {t('记忆加载失败，请重试。')}
                  <button type="button" className="text-button" onClick={() => loadTimeline(selectedBot)}>
                    {t('重试')}
                  </button>
                </p>
              ) : !timeline ? (
                <p role="status" className="memory-panel-state">
                  {t('加载中…')}
                </p>
              ) : timeline.length ? (
                <ol className="memory-episodes">
                  {timeline.map((episode) => (
                    <li key={episode.id}>
                      <time>{day(episode.endedAt, language)}</time>
                      <div>
                        <strong>{episode.title}</strong>
                        {episode.summary !== episode.title && <p>{episode.summary}</p>}
                        {episode.pending.length > 0 && (
                          <p className="memory-episode-pending">
                            {t('未完成：{items}', { items: episode.pending.join('；') })}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <SettingsEmpty icon="clock" title={t('还没有记录')} />
              )
            ) : loadFailed ? (
              <p role="alert" className="memory-panel-state">
                {t('记忆加载失败，请重试。')}
                <button type="button" className="text-button" onClick={() => void refresh()}>
                  {t('重试')}
                </button>
              </p>
            ) : loading && !items.length ? (
              <p role="status" className="memory-panel-state">
                {t('加载中…')}
              </p>
            ) : items.length ? (
              <ul className="memory-rows">
                {items.map((item) => (
                  <MemoryRow key={item.id} item={item} busy={busy} run={run} />
                ))}
              </ul>
            ) : (
              <SettingsEmpty icon="memory" title={query.trim() ? t('没有找到相关记忆') : t('还没有记忆')} />
            )}
          </div>
        </section>
      </div>
      <div hidden={page !== 'settings'}>
        {(learning || embedding) && (
          <div className="settings-card memory-switches">
            {learning && (
              <div className="settings-switch-row">
                <div className="settings-row-copy">
                  <span>{t('自动记忆')}</span>
                  <small>
                    {learning.enabled
                      ? t('对话结束后自动记下以后用得上的事，你可以随时修改或撤销')
                      : t('已暂停自动记忆，已有记忆仍可使用。')}
                  </small>
                </div>
                <Switch
                  label={t('自动记忆')}
                  on={learning.enabled}
                  disabled={busy}
                  onChange={() => act(() => window.aelion.setBackgroundLearning(!learning.enabled))}
                />
              </div>
            )}
            {embedding && (
              <div className="settings-switch-row">
                <div className="settings-row-copy">
                  <span>{t('语义检索')}</span>
                  <small>
                    {embedding.state === 'downloading'
                      ? t('正在下载本地模型 {percent}%', { percent: Math.round((embedding.progress || 0) * 100) })
                      : embedding.state === 'failed'
                        ? t('模型下载失败：{issue}。可以先关掉再打开重试，不影响按词搜索。', {
                            issue: embedding.issue || '',
                          })
                        : embedding.state === 'ready'
                          ? t('已索引 {indexed} 条，{pending} 条待处理', {
                              indexed: embedding.indexed,
                              pending: embedding.pending,
                            })
                          : t('下载约 {size} MB 的本地模型', { size: embedding.sizeMB })}
                  </small>
                </div>
                <Switch
                  label={t('语义检索')}
                  on={embedding.state === 'ready' || embedding.state === 'downloading'}
                  disabled={busy}
                  onChange={() =>
                    run(() =>
                      window.aelion.memorySetEmbedding(embedding.state === 'off' || embedding.state === 'failed'),
                    )
                  }
                />
              </div>
            )}
          </div>
        )}
        <SettingsSection title={t('记忆模型')}>
          <div className="model-assignment-panel">
            <div className="model-assignment">
              <ModelSelectionFields
                providers={providers}
                value={overview?.memoryModel || null}
                onChange={(next) => {
                  if (next === null || validModelSelection(next, providers))
                    run(() => window.aelion.setMemoryModel(next));
                }}
                disabled={busy}
                inheritDefault
                noneLabel={t('用每个 Bot 自己的模型')}
                defaultModel={state.defaultModel}
              />
            </div>
          </div>
        </SettingsSection>
        <SettingsSection title={t('数据')}>
          <div className="settings-card">
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('回顾过去的对话')}</span>
                {past && (
                  <small>
                    {t('{conversations} 段对话，约 {tokens} 输入 token，会花费你的模型额度。', {
                      conversations: past.conversations,
                      tokens: past.inputTokens.toLocaleString(language),
                    })}
                  </small>
                )}
              </div>
              {past ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => {
                    setPast(undefined);
                    run(() => window.aelion.memoryReadPast());
                  }}
                >
                  {t('开始')}
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void window.aelion.memoryPastEstimate().then(setPast, () => {})}
                >
                  {t('估算用量')}
                </button>
              )}
            </div>
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('导入与导出')}</span>
                <small>{t('导入到当前范围：{name}', { name: labelOf(selected) })}</small>
              </div>
              <div className="memory-row-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => run(() => window.aelion.memoryImport(selected))}
                >
                  {t('导入')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => run(() => window.aelion.memoryExport())}
                >
                  {t('导出')}
                </button>
              </div>
            </div>
          </div>
        </SettingsSection>
        {overview && (
          <SettingsSection title={t('最近 7 天')}>
            <dl className="settings-card memory-stats">
              <div>
                <dt>{t('记忆提取')}</dt>
                <dd>{overview.totals.capture[0].toLocaleString(language)}</dd>
              </div>
              <div>
                <dt>{t('提取失败')}</dt>
                <dd className={overview.totals.capture[1] ? 'is-warn' : undefined}>
                  {overview.totals.capture[1].toLocaleString(language)}
                </dd>
              </div>
              <div>
                <dt>{t('记忆整理')}</dt>
                <dd>{overview.totals.consolidate[0].toLocaleString(language)}</dd>
              </div>
              <div>
                <dt>{t('Token 用量')}</dt>
                <dd>{overview.totals.tokens.toLocaleString(language)}</dd>
              </div>
            </dl>
          </SettingsSection>
        )}
        {jobs.length > 0 && (
          <SettingsSection title={t('整理记录')}>
            <ul className="settings-card memory-jobs">
              {jobs.map((job) => (
                <li key={job.id}>
                  <div className="memory-job-copy">
                    <span>
                      {job.label || t('记忆')}
                      <em className={`memory-chip is-${job.status}`}>{t(JOB_STATUS[job.status] || job.status)}</em>
                    </span>
                    <small>
                      {[
                        moment(job.startedAt, language),
                        ...(job.changes > 0 ? [t('{count} 处改动', { count: job.changes })] : []),
                        ...(job.detail ? [job.detail] : []),
                      ].join(' · ')}
                    </small>
                  </div>
                  {job.status === 'completed' && job.changes > 0 && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => run(() => window.aelion.memoryUndoJob(job.id))}
                    >
                      {t('撤销这次整理')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}
