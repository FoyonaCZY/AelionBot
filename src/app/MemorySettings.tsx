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
import { Avatar } from '../ui/Avatar';
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
  busy,
  run,
}: {
  item: MemoryItem & { suggest?: { scope?: string; reason?: string } };
  pending?: boolean;
  busy: boolean;
  run: (operation: () => Promise<unknown>) => void;
}) {
  const { t, language } = useI18n();
  const [editing, setEditing] = useState<string>(),
    [detail, setDetail] = useState<MemoryItemDetail>();
  const when = new Date(item.recordedAt).toLocaleDateString(language);
  return (
    <li className={item.status === 'archived' ? 'memory-row archived' : 'memory-row'}>
      {editing === undefined ? (
        <p className="memory-text">
          {item.pinned && <Icon name="check" size={12} />}
          {item.text}
        </p>
      ) : (
        <textarea
          aria-label={t('记忆内容')}
          value={editing}
          maxLength={600}
          autoFocus
          onChange={(event) => setEditing(event.target.value)}
        />
      )}
      <div className="memory-meta">
        <span>{t(KINDS[item.kind])}</span>
        <span>{t(ORIGINS[item.origin])}</span>
        <span>{when}</span>
        {item.status === 'archived' && <span>{t('已归档')}</span>}
        {item.sensitivity === 'private' && <span>{t('私密')}</span>}
        {item.speaker && <span>{t('来自 {name}', { name: item.speaker })}</span>}
        {item.recallCount > 0 && <span>{t('想起过 {count} 次', { count: item.recallCount })}</span>}
      </div>
      {item.note && <p className="memory-note">{item.note}</p>}
      {item.suggest?.reason && <p className="memory-note">{item.suggest.reason}</p>}
      <div className="memory-actions">
        {editing !== undefined ? (
          <>
            <button
              type="button"
              className="text-button"
              disabled={busy || !editing.trim()}
              onClick={() => {
                const text = editing;
                setEditing(undefined);
                run(() => window.aelion.memoryUpdate({ id: item.id, text }));
              }}
            >
              {t('保存')}
            </button>
            <button type="button" className="text-button" onClick={() => setEditing(undefined)}>
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
        ) : (
          <>
            <button type="button" className="text-button" disabled={busy} onClick={() => setEditing(item.text)}>
              {t('修改')}
            </button>
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
          </>
        )}
        <button
          type="button"
          className="text-button"
          aria-expanded={Boolean(detail)}
          onClick={() =>
            detail ? setDetail(undefined) : void window.aelion.memoryDetail(item.id).then(setDetail, () => {})
          }
        >
          {t('为什么记得')}
        </button>
      </div>
      {detail && (
        <div className="memory-detail">
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
    [showArchived, setShowArchived] = useState(false),
    [options, setOptions] = useState<{ shareUser: boolean; mode: 'on' | 'read' | 'off' }>(),
    [past, setPast] = useState<{ conversations: number; inputTokens: number }>();
  const selected = area || (scopeBot ? 'bot:' + scopeBot.id : 'user');
  const list = useRef<HTMLUListElement>(null);
  useSwitchMotion(list, selected);
  const learning = state.cognition?.learning;
  const refresh = useCallback(async () => {
    const [nextOverview, nextItems, nextPending] = await Promise.all([
      window.aelion.memoryOverview(),
      window.aelion.memoryList({
        scope: selected,
        status: showArchived ? 'all' : 'active',
        ...(query.trim() ? { query } : {}),
      }),
      window.aelion.memoryList({ status: 'pending' }),
    ]);
    setOverview(nextOverview);
    setItems(nextItems);
    setPending(nextPending);
  }, [selected, query, showArchived]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh, state.cognition?.learning.working]);
  // The download reports its progress here.
  useEffect(() => {
    if (overview?.embedding.state !== 'downloading') return;
    const timer = setInterval(() => void refresh().catch(() => {}), 1500);
    return () => clearInterval(timer);
  }, [overview?.embedding.state, refresh]);
  const selectedBot = selected.startsWith('bot:') ? selected.slice(4) : undefined;
  useEffect(() => {
    setOptions(undefined);
    setTimeline(undefined);
    if (selectedBot) void window.aelion.memoryBotOptions(selectedBot).then(setOptions, () => {});
  }, [selectedBot]);
  const run = (operation: () => Promise<unknown>) => void act(operation).then(() => refresh().catch(() => {}));
  const choose = (next: string) => {
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
        <SettingsSection title={t('后台学习')}>
          <div className="settings-card">
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('自动记忆')}</span>
                <small>
                  {learning.runningBotId || learning.working
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
          </div>
        </SettingsSection>
      )}
      {pending.length > 0 && (
        <SettingsSection title={t('等你确认')} aside={<small>{pending.length}</small>}>
          <ul className="settings-card memory-rows">
            {pending.map((item) => (
              <MemoryRow key={item.id} item={item} pending busy={busy} run={run} />
            ))}
          </ul>
        </SettingsSection>
      )}
      <SettingsSection title={t('已有记忆')} aside={items.length ? <small>{items.length}</small> : undefined}>
        <div className="memory-bots" role="radiogroup" aria-label={t('选择范围')}>
          <button
            type="button"
            role="radio"
            className="memory-bot"
            aria-checked={selected === 'user'}
            onClick={() => choose('user')}
          >
            <span className="memory-scope-mark">
              <Icon name="memory" size={15} />
            </span>
            <span>{t('关于你')}</span>
            {countOf('user') > 0 && <small>{countOf('user')}</small>}
          </button>
          {state.bots.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              className="memory-bot"
              aria-checked={selected === 'bot:' + item.id}
              onClick={() => choose('bot:' + item.id)}
            >
              <Avatar bot={item} size={28} />
              <span>{item.name}</span>
              {countOf('bot:' + item.id) > 0 && <small>{countOf('bot:' + item.id)}</small>}
            </button>
          ))}
          {others.map((item) => (
            <button
              key={item.scope}
              type="button"
              role="radio"
              className="memory-bot"
              aria-checked={selected === item.scope}
              onClick={() => choose(item.scope)}
            >
              <span className="memory-scope-mark">
                <Icon name={item.kind === 'project' ? 'folder' : 'user'} size={15} />
              </span>
              <span>{item.label}</span>
              {item.count > 0 && <small>{item.count}</small>}
            </button>
          ))}
        </div>
        <div className="memory-filter">
          <input
            type="search"
            aria-label={t('搜索记忆')}
            placeholder={t('搜索记忆')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label>
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            {t('显示已归档')}
          </label>
        </div>
        {items.length ? (
          <ul ref={list} className="settings-card memory-rows">
            {items.map((item) => (
              <MemoryRow key={item.id} item={item} busy={busy} run={run} />
            ))}
          </ul>
        ) : (
          <SettingsEmpty icon="memory" title={t('还没有记忆')} />
        )}
      </SettingsSection>
      {selectedBot && options && (
        <SettingsSection title={t('这个 Bot')}>
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
                  setOptions({ ...options, shareUser });
                  run(() => window.aelion.memorySetBotOptions({ botId: selectedBot, shareUser }));
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
                  setOptions({ ...options, mode });
                  run(() => window.aelion.memorySetBotOptions({ botId: selectedBot, mode }));
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
                void window.aelion.memoryTimeline({ botId: selectedBot, limit: 40 }).then(setTimeline, () => {});
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
        </SettingsSection>
      )}
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
      <SettingsSection title={t('更多设置')}>
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
                  run(() => window.aelion.memorySetEmbedding(embedding.state === 'off' || embedding.state === 'failed'))
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
    </>
  );
}
