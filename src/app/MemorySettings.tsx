import { useCallback, useEffect, useRef, useState } from 'react';
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
import { SettingsSection, SettingsEmpty } from '../settings/SettingsWindow';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
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
function MemoryRow({
  item,
  pending,
  scopeLabel,
  busy,
  run,
}: {
  item: MemoryItem & { suggest?: { scope?: string; reason?: string } };
  pending?: boolean;
  scopeLabel?: string;
  busy: boolean;
  run: (operation: () => Promise<unknown>) => void;
}) {
  const { t, language } = useI18n();
  const [editing, setEditing] = useState<string>(),
    [expanded, setExpanded] = useState(false),
    [detail, setDetail] = useState<MemoryItemDetail>(),
    [detailFailed, setDetailFailed] = useState(false);
  const loadDetail = () => {
    setDetailFailed(false);
    void window.aelion.memoryDetail(item.id).then(setDetail, () => setDetailFailed(true));
  };
  const when = new Date(item.recordedAt).toLocaleDateString(language);
  return (
    <li className={item.status === 'archived' ? 'memory-row archived' : 'memory-row'}>
      <div className="memory-row-main">
        {editing === undefined ? (
          <p className="memory-text">
            {item.pinned && <span className="memory-tag">{t('已置顶')}</span>}
            {item.text}
          </p>
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
        {editing === undefined && (
          <div className="memory-row-tools">
            {!pending && (
              <button
                type="button"
                className="icon-button"
                title={t('修改')}
                aria-label={t('修改')}
                disabled={busy}
                onClick={() => setEditing(item.text)}
              >
                <Icon name="edit" size={15} />
              </button>
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
      {(scopeLabel || item.status === 'archived' || item.sensitivity === 'private') && (
        <div className="memory-meta">
          {scopeLabel && <span>{scopeLabel}</span>}
          {item.status === 'archived' && <span>{t('已归档')}</span>}
          {item.sensitivity === 'private' && <span>{t('私密')}</span>}
        </div>
      )}
      {pending && item.note && <p className="memory-note">{item.note}</p>}
      {pending && item.suggest?.reason && <p className="memory-note">{item.suggest.reason}</p>}
      {(editing !== undefined || pending) && (
        <div className="memory-actions">
          {editing !== undefined ? (
            <>
              <button
                type="button"
                className="text-button"
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
              <button type="button" className="text-button" disabled={busy} onClick={() => setEditing(undefined)}>
                {t('取消')}
              </button>
            </>
          ) : pending ? (
            <>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => run(() => window.aelion.memoryConfirm(item.id))}
              >
                {item.suggest?.scope === 'user' ? t('让所有 Bot 知道') : t('确认')}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => run(() => window.aelion.memoryReject(item.id))}
              >
                {item.status === 'candidate' ? t('不要记') : t('保持原样')}
              </button>
            </>
          ) : null}
        </div>
      )}
      {expanded && (
        <div className="memory-detail">
          <div className="memory-meta">
            <span>{t(KINDS[item.kind])}</span>
            <span>{t(ORIGINS[item.origin])}</span>
            <span>{when}</span>
            {item.speaker && <span>{t('来自 {name}', { name: item.speaker })}</span>}
            {item.recallCount > 0 && <span>{t('想起过 {count} 次', { count: item.recallCount })}</span>}
          </div>
          {!pending && item.note && <p className="memory-note">{item.note}</p>}
          {!pending && (
            <div className="memory-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => run(() => window.aelion.memoryUpdate({ id: item.id, pinned: !item.pinned }))}
              >
                {item.pinned ? t('取消置顶') : t('置顶')}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => run(() => window.aelion.memoryForget(item.id))}
              >
                {t('忘记')}
              </button>
            </div>
          )}
          <p className="memory-detail-title">{t('为什么记得')}</p>
          {detailFailed ? (
            <p role="alert">
              {t('记忆详情加载失败')}{' '}
              <button type="button" className="text-button" onClick={loadDetail}>
                {t('重试')}
              </button>
            </p>
          ) : !detail ? (
            <p role="status">{t('加载中…')}</p>
          ) : (
            <>
              {detail.sources.length ? (
                detail.sources.map((source, index) => (
                  <blockquote key={index}>
                    {source.available ? source.excerpt : t('原始消息已不存在')}
                    {source.at && <cite>{new Date(source.at).toLocaleString(language)}</cite>}
                  </blockquote>
                ))
              ) : (
                <p>{t('没有记录来源')}</p>
              )}
              <ul>
                {detail.history.map((event) => (
                  <li key={event.id}>
                    {new Date(event.at).toLocaleString(language)} ·{' '}
                    {ACTIONS[event.action] ? t(ACTIONS[event.action]) : event.action}
                  </li>
                ))}
              </ul>
            </>
          )}
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
  busy,
  act,
}: {
  state: Snapshot;
  bot?: Bot;
  scope: string;
  onScope: (id: string) => void;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const { t, language } = useI18n();
  const scopeBot = state.bots.find((item) => item.id === scope) || bot || state.bots[0];
  const [area, setArea] = useState<string>(),
    [overview, setOverview] = useState<MemoryOverview>(),
    [items, setItems] = useState<MemoryItem[]>([]),
    [pending, setPending] = useState<MemoryItem[]>([]),
    [timeline, setTimeline] = useState<MemoryEpisode[]>(),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true),
    [loadFailed, setLoadFailed] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [options, setOptions] = useState<{ shareUser: boolean; mode: 'on' | 'read' | 'off' }>(),
    [past, setPast] = useState<{ conversations: number; inputTokens: number }>();
  const selected = area || (scopeBot ? 'bot:' + scopeBot.id : 'user');
  const view = JSON.stringify([selected, query, showArchived]),
    currentView = useRef(view),
    refreshVersion = useRef(0);
  currentView.current = view;
  const list = useRef<HTMLUListElement>(null);
  useSwitchMotion(list, selected);
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
    setItems([]);
    setLoading(true);
    setQuery('');
    setArea(next);
    if (next.startsWith('bot:')) onScope(next.slice(4));
  };
  const others = overview?.scopes.filter((item) => item.kind === 'project' || item.kind === 'group') || [],
    countOf = (id: string) => overview?.scopes.find((item) => item.scope === id)?.count || 0,
    embedding = overview?.embedding,
    providers = state.providers || [];
  return (
    <>
      {learning && (
        <div className="settings-card memory-learning">
          <div className="settings-switch-row">
            <div className="settings-row-copy">
              <span>{t('自动记忆')}</span>
              <small>
                {!learning.enabled
                  ? t('已暂停自动记忆，已有记忆仍可使用。')
                  : learning.runningBotId || learning.working
                    ? t('正在整理经验')
                    : learning.queued > 0
                      ? t('{count} 项等待整理', { count: learning.queued })
                      : t('对话结束后自动记下以后用得上的事，你可以随时修改或撤销')}
              </small>
            </div>
            <Switch
              label={t('自动记忆')}
              on={learning.enabled}
              disabled={busy}
              onChange={() => act(() => window.aelion.setBackgroundLearning(!learning.enabled))}
            />
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <details className="memory-disclosure memory-pending">
          <summary>
            <Icon name="chevron" size={15} />
            <span>{t('等你确认')}</span>
            <small>{pending.length}</small>
          </summary>
          <ul className="settings-card memory-rows">
            {pending.map((item) => (
              <MemoryRow
                key={item.id}
                item={item}
                scopeLabel={
                  item.scope === 'user'
                    ? t('关于你')
                    : overview?.scopes.find((entry) => entry.scope === item.scope)?.label
                }
                pending
                busy={busy}
                run={run}
              />
            ))}
          </ul>
        </details>
      )}
      <SettingsSection title={t('已有记忆')} aside={items.length ? <small>{items.length}</small> : undefined}>
        <div className="memory-toolbar">
          <Select
            className="settings-select memory-scope-select"
            aria-label={t('选择范围')}
            value={selected}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="user">
              {t('关于你')}
              {countOf('user') ? ` · ${countOf('user')}` : ''}
            </option>
            {state.bots.map((item) => (
              <option key={item.id} value={'bot:' + item.id}>
                {item.name}
                {countOf('bot:' + item.id) ? ` · ${countOf('bot:' + item.id)}` : ''}
              </option>
            ))}
            {others.map((item) => (
              <option key={item.scope} value={item.scope}>
                {item.label}
                {item.count ? ` · ${item.count}` : ''}
              </option>
            ))}
          </Select>
          <div className="memory-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              aria-label={t('搜索记忆')}
              placeholder={t('搜索记忆')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="memory-filter">
          <label>
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            {t('显示已归档')}
          </label>
        </div>
        {loadFailed ? (
          <p role="alert" className="settings-note">
            {t('记忆加载失败，请重试。')}{' '}
            <button type="button" className="text-button" onClick={() => void refresh()}>
              {t('重试')}
            </button>
          </p>
        ) : loading && !items.length ? (
          <p role="status" className="settings-note">
            {t('加载中…')}
          </p>
        ) : items.length ? (
          <ul ref={list} className="settings-card memory-rows">
            {items.map((item) => (
              <MemoryRow key={item.id} item={item} busy={busy} run={run} />
            ))}
          </ul>
        ) : (
          <SettingsEmpty
            icon="memory"
            title={query.trim() ? t('没有找到相关记忆') : t('还没有记忆')}
            description={query.trim() ? t('试试其他关键词，或清空搜索查看全部记忆。') : undefined}
          />
        )}
      </SettingsSection>
      {selectedBot && options && (
        <details key={selectedBot} className="memory-disclosure">
          <summary>
            <Icon name="chevron" size={15} />
            <span>
              {t('{name} 的记忆设置', {
                name: state.bots.find((item) => item.id === selectedBot)?.name || t('这个 Bot'),
              })}
            </span>
          </summary>
          <div className="settings-card">
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('使用关于你的记忆')}</span>
                <small>{t('角色扮演类的 Bot 可以关掉')}</small>
              </div>
              <Switch
                label={t('使用关于你的记忆')}
                on={options.shareUser}
                disabled={busy}
                onChange={() => {
                  const shareUser = !options.shareUser;
                  run(async () => {
                    await window.aelion.memorySetBotOptions({ botId: selectedBot, shareUser });
                    if (currentBot.current === selectedBot) setOptions({ ...options, shareUser });
                  });
                }}
              />
            </div>
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('记忆方式')}</span>
              </div>
              <select
                className="settings-select"
                aria-label={t('记忆方式')}
                value={options.mode}
                disabled={busy}
                onChange={(event) => {
                  const mode = event.target.value as 'on' | 'read' | 'off';
                  run(async () => {
                    await window.aelion.memorySetBotOptions({ botId: selectedBot, mode });
                    if (currentBot.current === selectedBot) setOptions({ ...options, mode });
                  });
                }}
              >
                <option value="on">{t('使用并记住')}</option>
                <option value="read">{t('只用，不记新的')}</option>
                <option value="off">{t('不使用')}</option>
              </select>
            </div>
          </div>
          <details
            className="memory-timeline"
            onToggle={(event) => {
              if ((event.target as HTMLDetailsElement).open && !timeline)
                void window.aelion.memoryTimeline({ botId: selectedBot, limit: 40 }).then(
                  (next) => {
                    if (currentBot.current === selectedBot) setTimeline(next);
                  },
                  () => {},
                );
            }}
          >
            <summary>{t('做过的事')}</summary>
            {timeline?.length ? (
              <ol>
                {timeline.map((episode) => (
                  <li key={episode.id}>
                    <time>{new Date(episode.endedAt).toLocaleDateString(language)}</time>
                    <strong>{episode.title}</strong>
                    {episode.summary !== episode.title && <p>{episode.summary}</p>}
                    {episode.pending.length > 0 && <p>{t('未完成：{items}', { items: episode.pending.join('；') })}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="settings-note">{t('还没有记录')}</p>
            )}
          </details>
        </details>
      )}
      <details className="memory-disclosure memory-advanced">
        <summary>
          <Icon name="chevron" size={15} />
          <span>{t('更多设置')}</span>
          <small>{t('模型、导入与整理记录')}</small>
        </summary>
        {overview && overview.jobs.some((job) => job.kind === 'consolidate') && (
          <SettingsSection title={t('整理记录')}>
            <ul className="settings-card memory-jobs">
              {overview.jobs
                .filter((job) => job.kind === 'consolidate')
                .slice(0, 8)
                .map((job) => (
                  <li key={job.id}>
                    <div>
                      <span>{job.label || t('记忆')}</span>
                      <small>
                        {new Date(job.startedAt).toLocaleString(language)} · {t(JOB_STATUS[job.status] || job.status)}
                        {job.changes > 0 ? ' · ' + t('{count} 处改动', { count: job.changes }) : ''}
                        {job.detail ? ' · ' + job.detail : ''}
                      </small>
                    </div>
                    {job.status === 'completed' && job.changes > 0 && (
                      <button
                        type="button"
                        className="text-button"
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
        <SettingsSection title={t('记忆设置')}>
          <div className="settings-card">
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
                          ? t('已索引 {indexed} 条，{pending} 条待处理。模型在本机运行，内容不会发出去。', {
                              indexed: embedding.indexed,
                              pending: embedding.pending,
                            })
                          : t('下载约 {size} MB 的本地模型，换个说法也能想起', { size: embedding.sizeMB })}
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
            <div className="memory-model">
              <div className="settings-row-copy">
                <span>{t('记忆模型')}</span>
                <small>{t('后台提取和整理用的模型。可以换成便宜的，对话内容会发给所选的服务商。')}</small>
              </div>
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
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('回顾过去的对话')}</span>
                <small>
                  {past
                    ? t('{conversations} 段对话，约 {tokens} 输入 token，会花费你的模型额度。', {
                        conversations: past.conversations,
                        tokens: past.inputTokens.toLocaleString(language),
                      })
                    : t('从已有的对话里提取记忆')}
                </small>
              </div>
              {past ? (
                <button
                  type="button"
                  className="text-button"
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
                  className="text-button"
                  onClick={() => void window.aelion.memoryPastEstimate().then(setPast, () => {})}
                >
                  {t('估算用量')}
                </button>
              )}
            </div>
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('导入与导出')}</span>
                <small>{t('导入的记忆要你确认后才会使用，会放进上面选中的范围。')}</small>
              </div>
              <div className="memory-transfer">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => run(() => window.aelion.memoryImport(selected))}
                >
                  {t('导入')}
                </button>
                <button type="button" className="text-button" onClick={() => run(() => window.aelion.memoryExport())}>
                  {t('导出')}
                </button>
              </div>
            </div>
          </div>
          <p className="settings-note">
            {t('忘记一条记忆后，它不会再被用到，也不会被自动记回来；但已经发给模型服务的内容无法追回。')}
          </p>
        </SettingsSection>
        {overview && (
          <p className="settings-note memory-totals">
            {t('近 7 天：提取成功 {ok} 次，失败 {failed} 次；整理 {merged} 次；用量 {tokens} token', {
              ok: overview.totals.capture[0],
              failed: overview.totals.capture[1],
              merged: overview.totals.consolidate[0],
              tokens: overview.totals.tokens.toLocaleString(language),
            })}
          </p>
        )}
      </details>
    </>
  );
}
