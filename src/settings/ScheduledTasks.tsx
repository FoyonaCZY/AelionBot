import { Select } from '../ui/Select';
import { Combobox } from '../ui/Combobox';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
import { Presence } from '../ui/Presence';
import {
  localDateParts,
  nextTaskTime,
  sameTaskTarget,
  scheduleLabel,
  taskExecuting,
  triggerLabel,
  wallTimeToInstant,
  type AutomationTrigger,
  type ScheduledTask,
  type ScheduledTaskStatus,
  type TaskSchedule,
  type TaskTarget,
} from '../../shared/types/scheduled-types';
import { CONNECTOR_PLATFORM_NAMES, type ConnectorView } from '../../shared/types/connector-types';
import { useI18n, translate } from '../i18n';
import '../bots/companion-cards.css';
import './scheduled-tasks.css';

const errorText = (error: unknown) =>
  (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '');
const statuses = { enabled: '已开启', paused: '已暂停', completed: '已完成' };
const executionLabels = {
  queued: '等待执行',
  running: '正在执行',
  completed: '执行完成',
  failed: '执行失败',
  cancelled: '执行已停止',
  interrupted: '执行中断',
};
const SCRIPT_EXAMPLE = `// 每次检查都会运行这段代码。可用 state（上次保存的数据）和 tools.fetch。
const res = await tools.fetch({ url: 'https://api.github.com/repos/nodejs/node/releases/latest' });
const tag = JSON.parse(res.body).tag_name;
if (state && state.tag !== tag) return { fire: true, message: '有新版本 ' + tag, state: { tag } };
return { fire: false, state: { tag } };`;

function nextLabel(task: ScheduledTask, now: number) {
  if (taskExecuting(task)) return translate(executionLabels[task.lastRun!.status]);
  if (task.needsReview) return translate('等你查看脚本后启用');
  if (task.status !== 'enabled') return translate(statuses[task.status]);
  if (task.pending) return translate('已触发，等待会话空闲');
  if (task.trigger.kind !== 'schedule' && task.trigger.kind !== 'script') return translate('等待触发');
  if (!task.nextRunAt) return translate('等待执行');
  const delta = Date.parse(task.nextRunAt) - now;
  if (delta <= 0) return translate(task.trigger.kind === 'script' ? '正在检查' : '等待会话空闲');
  if (delta < 60000) return translate(task.trigger.kind === 'script' ? '即将检查' : '即将运行');
  const value =
    delta < 3600000
      ? translate('{count} 分钟后', { count: Math.ceil(delta / 60000) })
      : delta < 86400000
        ? translate('{count} 小时后', { count: Math.ceil(delta / 3600000) })
        : translate('{count} 天后', { count: Math.floor(delta / 86400000) });
  return translate(task.trigger.kind === 'script' ? '下次检查 {value}' : '下次运行 {value}', { value });
}
export function ScheduledTasks({
  target,
  targetName,
  tasks,
  connectors = [],
  webhookOrigin,
  onError,
  onModalChange,
}: {
  target?: TaskTarget;
  targetName: string;
  tasks: ScheduledTask[];
  connectors?: ConnectorView[];
  /** The local origin webhooks are called on, while the app listens. */
  webhookOrigin?: string;
  onError: (text: string) => void;
  onModalChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<'all' | ScheduledTaskStatus>('all'),
    [editing, setEditing] = useState<ScheduledTask | 'new'>(),
    [pending, setPending] = useState(''),
    [now, setNow] = useState(Date.now());
  const list = useRef<HTMLDivElement>(null);
  useSwitchMotion(list, filter);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setEditing(undefined);
    setFilter('all');
  }, [target?.kind, target?.id, target?.sessionId]);
  useEffect(() => {
    onModalChange(Boolean(editing));
    return () => onModalChange(false);
  }, [Boolean(editing)]);
  const scoped = target ? tasks.filter((task) => sameTaskTarget(task.target, target)) : [],
    visible = scoped
      .filter((task) => filter === 'all' || task.status === filter)
      .sort(
        (a, b) =>
          Number(b.status === 'enabled') - Number(a.status === 'enabled') ||
          (a.nextRunAt || a.createdAt).localeCompare(b.nextRunAt || b.createdAt),
      );
  const toggle = async (task: ScheduledTask) => {
    // A script a Bot wrote opens for reading first; turning it on happens there.
    if (task.needsReview) return setEditing(task);
    setPending(task.id);
    try {
      await window.aelion.updateScheduledTask({
        id: task.id,
        status: task.status === 'enabled' ? 'paused' : 'enabled',
      });
    } catch (error) {
      onError(errorText(error));
    } finally {
      setPending('');
    }
  };
  return (
    <section className="scheduled-panel" aria-label={t('自动化')}>
      <header>
        <h2>
          {t('自动化')}
          {scoped.length > 0 && <span>{scoped.length}</span>}
        </h2>
        <button
          type="button"
          className="scheduled-add"
          aria-label={t('创建自动化')}
          title={t('创建自动化')}
          disabled={!target}
          onClick={() => setEditing('new')}
        >
          <Icon name="plus" size={17} />
        </button>
      </header>
      {/* Filters only earn their space once the list is long. */}
      {(scoped.length > 5 || filter !== 'all') && (
        <div className="scheduled-filters" aria-label={t('筛选自动化')}>
          {(['all', 'enabled', 'paused', 'completed'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? t('全部') : t(statuses[value])}
            </button>
          ))}
        </div>
      )}
      <div ref={list} className="scheduled-list">
        {visible.map((task) => {
          const running = taskExecuting(task),
            failed = Boolean(task.error) && !running,
            label = triggerLabel(task.trigger);
          return (
            <article
              key={task.id}
              className={`scheduled-row ${task.status} ${running ? 'is-running' : ''} ${failed ? 'has-error' : ''}`}
              data-task-id={task.id}
            >
              <button
                type="button"
                className="scheduled-open"
                onClick={() => setEditing(task)}
                aria-label={t('编辑自动化 {title}', { title: task.title })}
              >
                <strong title={task.title}>{task.title}</strong>
                <span
                  className="scheduled-frequency"
                  title={task.trigger.kind === 'schedule' ? `${label} · ${task.trigger.schedule.timeZone}` : label}
                >
                  {label}
                </span>
              </button>
              <div className="scheduled-row-footer">
                <small
                  className={`scheduled-next ${failed ? 'scheduled-failed' : ''}`}
                  title={failed ? task.error : undefined}
                >
                  {failed ? t('上次执行未完成') : nextLabel(task, now)}
                </small>
                {task.status !== 'completed' && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={task.status === 'enabled'}
                    className="scheduled-toggle"
                    disabled={pending === task.id}
                    aria-label={t('{action}自动化 {title}', {
                      action: t(task.status === 'enabled' ? '暂停' : '恢复'),
                      title: task.title,
                    })}
                    title={task.status === 'enabled' ? t('暂停') : t('恢复')}
                    onClick={() => void toggle(task)}
                  >
                    <span className="scheduled-toggle-track" aria-hidden="true" />
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {!visible.length && (
          <div className="scheduled-empty">
            <strong>{scoped.length ? t('没有符合条件的自动化') : t('暂无自动化')}</strong>
            {!target && <p>{t('选择一个会话来安排自动化。')}</p>}
            {scoped.length ? (
              <button type="button" onClick={() => setFilter('all')}>
                {t('查看全部')}
              </button>
            ) : (
              <button type="button" disabled={!target} onClick={() => setEditing('new')}>
                <Icon name="plus" size={13} />
                {t('添加自动化')}
              </button>
            )}
          </div>
        )}
      </div>
      <Presence>
        {editing && target && (
          <ScheduledTaskEditor
            key={editing === 'new' ? 'new' : editing.id}
            task={editing === 'new' ? undefined : editing}
            live={editing === 'new' ? undefined : tasks.find((task) => task.id === editing.id)}
            tasks={tasks}
            connectors={connectors}
            webhookOrigin={webhookOrigin}
            target={target}
            targetName={targetName}
            onClose={() => setEditing(undefined)}
          />
        )}
      </Presence>
    </section>
  );
}

function localInput(at: number, timeZone: string) {
  const p = localDateParts(at, timeZone),
    pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
type TriggerKind = 'schedule' | 'webhook' | 'event' | 'script';
type EventKind = 'file' | 'message' | 'automation';
function ScheduledTaskEditor({
  task,
  live,
  tasks,
  connectors,
  webhookOrigin,
  target,
  targetName,
  onClose,
}: {
  task?: ScheduledTask;
  live?: ScheduledTask;
  tasks: ScheduledTask[];
  connectors: ConnectorView[];
  webhookOrigin?: string;
  target: TaskTarget;
  targetName: string;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const saved = task?.trigger,
    existing = saved?.kind === 'schedule' ? saved.schedule : undefined,
    defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title, setTitle] = useState(task?.title || ''),
    [prompt, setPrompt] = useState(task?.prompt || ''),
    [status, setStatus] = useState<ScheduledTaskStatus>(task?.status || 'enabled');
  const [triggerKind, setTriggerKind] = useState<TriggerKind>(
    !saved || saved.kind === 'schedule'
      ? 'schedule'
      : saved.kind === 'webhook' || saved.kind === 'script'
        ? saved.kind
        : 'event',
  );
  const [eventKind, setEventKind] = useState<EventKind>(
    saved?.kind === 'file' || saved?.kind === 'message' || saved?.kind === 'automation' ? saved.kind : 'file',
  );
  const [folder, setFolder] = useState(saved?.kind === 'file' ? saved.path : ''),
    [connectorId, setConnectorId] = useState(saved?.kind === 'message' ? saved.connectorId || '' : ''),
    [keyword, setKeyword] = useState(saved?.kind === 'message' ? saved.keyword || '' : ''),
    [after, setAfter] = useState(saved?.kind === 'automation' ? saved.automationId : ''),
    [outcome, setOutcome] = useState<'completed' | 'failed' | 'any'>(
      saved?.kind === 'automation' ? saved.outcome : 'completed',
    ),
    [code, setCode] = useState(saved?.kind === 'script' ? saved.code : SCRIPT_EXAMPLE),
    [checkMinutes, setCheckMinutes] = useState(saved?.kind === 'script' ? saved.minutes : 15),
    [copied, setCopied] = useState(false);
  const [kind, setKind] = useState<'once' | 'daily' | 'weekdays' | 'weekly' | 'interval'>(
    existing?.kind === 'weekly' && [...existing.weekdays].sort().join(',') === '1,2,3,4,5'
      ? 'weekdays'
      : existing?.kind || 'daily',
  );
  const [timeZone, setTimeZone] = useState(existing?.timeZone || defaultZone),
    [time, setTime] = useState(
      existing && (existing.kind === 'daily' || existing.kind === 'weekly') ? existing.time : '09:00',
    ),
    [at, setAt] = useState(
      existing?.kind === 'once'
        ? localInput(Date.parse(existing.at), existing.timeZone)
        : localInput(Date.now() + 3600000, defaultZone),
    );
  const [days, setDays] = useState(existing?.kind === 'weekly' ? existing.weekdays : [1]),
    [minutes, setMinutes] = useState(existing?.kind === 'interval' ? existing.minutes : 60),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLElement>(null),
    deleteButton = useRef<HTMLButtonElement>(null),
    deleteCancel = useRef<HTMLButtonElement>(null),
    wasDeleting = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector('input')?.focus();
    return () => {
      previous?.isConnected && previous.focus();
    };
  }, []);
  useEffect(() => {
    if (deleting) deleteCancel.current?.focus({ preventScroll: true });
    else if (wasDeleting.current) deleteButton.current?.focus({ preventScroll: true });
    wasDeleting.current = deleting;
  }, [deleting]);
  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await action();
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  };
  const currentSchedule = (): TaskSchedule => {
    if (kind === 'once') {
      if (
        existing?.kind === 'once' &&
        timeZone === existing.timeZone &&
        at === localInput(Date.parse(existing.at), timeZone)
      )
        return existing;
      const [date, clock] = at.split('T'),
        value = date && clock ? wallTimeToInstant(date, clock, timeZone) : undefined;
      if (value === undefined) throw new Error(t('执行日期或时间无效'));
      return { kind: 'once', at: new Date(value).toISOString(), timeZone };
    }
    if (kind === 'interval') return { kind, minutes, timeZone };
    if (kind === 'daily') return { kind, time, timeZone };
    return { kind: 'weekly', time, weekdays: kind === 'weekdays' ? [1, 2, 3, 4, 5] : [...days].sort(), timeZone };
  };
  /** The trigger as edited; a webhook keeps the saved secret, which the app owns. */
  const currentTrigger = (): AutomationTrigger => {
    if (triggerKind === 'schedule') return { kind: 'schedule', schedule: currentSchedule() };
    if (triggerKind === 'webhook')
      return saved?.kind === 'webhook' ? saved : ({ kind: 'webhook' } as AutomationTrigger);
    if (triggerKind === 'script') return { kind: 'script', code, minutes: checkMinutes };
    if (eventKind === 'file') return { kind: 'file', path: folder.trim() };
    if (eventKind === 'message')
      return {
        kind: 'message',
        ...(connectorId ? { connectorId } : {}),
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      };
    return { kind: 'automation', automationId: after, outcome };
  };
  let dirty = Boolean(task);
  try {
    dirty = Boolean(
      task &&
      (title !== task.title ||
        prompt !== task.prompt ||
        status !== task.status ||
        JSON.stringify(currentTrigger()) !== JSON.stringify(task.trigger)),
    );
  } catch {
    /* Incomplete time fields are validated on save. */
  }
  let preview = t('设置时间后查看执行安排');
  if (triggerKind === 'schedule')
    try {
      const schedule = currentSchedule(),
        current = live || task,
        savedTiming = task && JSON.stringify({ kind: 'schedule', schedule }) === JSON.stringify(task.trigger);
      const describeNext = (value: string) =>
        t('下次执行 {date}', {
          date: new Date(value).toLocaleString(language, {
            timeZone: schedule.timeZone,
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }),
        });
      if (status === 'paused') preview = t('已暂停，恢复后按此安排执行');
      else if (status === 'completed') preview = t('任务已结束');
      else if (savedTiming && current && taskExecuting(current)) preview = t(executionLabels[current.lastRun!.status]);
      else if (savedTiming && current?.nextRunAt)
        preview = Date.parse(current.nextRunAt) > Date.now() ? describeNext(current.nextRunAt) : t('等待执行');
      else if (schedule.kind === 'interval')
        preview =
          Number.isInteger(schedule.minutes) && schedule.minutes >= 1
            ? t('{schedule}执行一次', { schedule: t(scheduleLabel(schedule)) })
            : t('请输入执行间隔');
      else {
        const next = nextTaskTime(schedule, Date.now());
        preview = next ? describeNext(next) : t('执行时间已过去，请重新选择');
      }
    } catch {
      /* Keep partial date and timezone input editable. */
    }
  const webhookUrl =
    saved?.kind === 'webhook' && task && webhookOrigin ? `${webhookOrigin}/hooks/${task.id}/${saved.token}` : '';
  const others = tasks.filter((item) => item.id !== task?.id);
  const ready =
    title.trim() &&
    prompt.trim() &&
    !(triggerKind === 'schedule' && kind === 'weekly' && !days.length) &&
    !(triggerKind === 'event' && eventKind === 'file' && !folder.trim()) &&
    !(triggerKind === 'event' && eventKind === 'automation' && !after) &&
    !(triggerKind === 'script' && !code.trim());
  const save = (statusOverride?: ScheduledTaskStatus) =>
    run(async () => {
      const trigger = currentTrigger(),
        next = statusOverride || status;
      if (task) await window.aelion.updateScheduledTask({ id: task.id, title, prompt, trigger, status: next });
      else await window.aelion.createScheduledTask({ target, title, prompt, trigger });
    });
  return (
    <div
      className="scheduled-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={root}
        className="scheduled-editor companion-surface"
        role="dialog"
        aria-modal="true"
        aria-label={task ? t('编辑自动化') : t('创建自动化')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault();
            event.stopPropagation();
            if (deleting) setDeleting(false);
            else onClose();
          }
          if (event.key === 'Tab') {
            const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)',
                ),
              ].filter((item) => item.tabIndex >= 0),
              index = items.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index <= 0) {
              event.preventDefault();
              items.at(-1)?.focus();
            } else if (!event.shiftKey && index === items.length - 1) {
              event.preventDefault();
              items[0]?.focus();
            }
          }
        }}
      >
        <header>
          <Avatar bot={{ name: 'AelionBot', color: '#8b6bea' }} size={30} activity={pending ? 'working' : 'idle'} />
          <div className="scheduled-editor-heading">
            <h2>{task ? t('编辑自动化') : t('新建自动化')}</h2>
            <span title={targetName}>
              {target.kind === 'group' ? t('群聊') : 'Bot'} · {targetName}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('关闭自动化')}
            disabled={pending}
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="scheduled-editor-body">
            {task?.needsReview && (
              <p className="scheduled-review" role="status">
                {t('这个检查脚本由 {name} 编写。请读一遍代码，确认没问题再启用。', { name: task.createdBy.name })}
              </p>
            )}
            <label className="scheduled-name">
              {t('名称')}
              <input
                aria-label={t('自动化名称')}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={80}
                placeholder={t('例如：每日简报')}
                disabled={pending}
                required
              />
            </label>
            <label>
              {t('要做的事')}
              <textarea
                aria-label={t('任务内容')}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                maxLength={8000}
                placeholder={t('触发后需要 Bot 做什么？')}
                disabled={pending}
                required
              />
            </label>
            <section className="scheduled-timing">
              <h3>{t('触发方式')}</h3>
              <div className="scheduled-trigger-kinds" role="radiogroup" aria-label={t('触发方式')}>
                {(
                  [
                    ['schedule', '定时'],
                    ['event', '事件'],
                    ['webhook', 'Webhook'],
                    ['script', '检查脚本'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    role="radio"
                    key={value}
                    aria-checked={triggerKind === value}
                    className={triggerKind === value ? 'selected' : ''}
                    disabled={pending}
                    onClick={() => setTriggerKind(value)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              {triggerKind === 'schedule' && (
                <>
                  <div className="scheduled-form-grid">
                    <label>
                      {t('重复')}
                      <Select
                        aria-label={t('重复方式')}
                        value={kind}
                        onChange={(event) => setKind(event.target.value as typeof kind)}
                        disabled={pending}
                      >
                        <option value="once">{t('仅一次')}</option>
                        <option value="daily">{t('每天')}</option>
                        <option value="weekdays">{t('工作日')}</option>
                        <option value="weekly">{t('每周')}</option>
                        <option value="interval">{t('固定间隔')}</option>
                      </Select>
                    </label>
                    {kind === 'once' ? (
                      <label>
                        {t('执行时间')}
                        <input
                          aria-label={t('执行时间')}
                          type="datetime-local"
                          value={at}
                          onChange={(event) => setAt(event.target.value)}
                          disabled={pending}
                          required
                        />
                      </label>
                    ) : kind === 'interval' ? (
                      <label>
                        {t('间隔（分钟）')}
                        <input
                          aria-label={t('间隔分钟')}
                          type="number"
                          min={1}
                          max={525600}
                          value={minutes}
                          onChange={(event) => setMinutes(Number(event.target.value))}
                          disabled={pending}
                          required
                        />
                      </label>
                    ) : (
                      <label>
                        {t('时间')}
                        <input
                          aria-label={t('执行时刻')}
                          type="time"
                          value={time}
                          onChange={(event) => setTime(event.target.value)}
                          disabled={pending}
                          required
                        />
                      </label>
                    )}
                  </div>
                  {kind === 'weekly' && (
                    <div className="scheduled-weekday-field">
                      <span>{t('执行日期')}</span>
                      <div className="scheduled-weekdays" role="group" aria-label={t('执行星期')}>
                        {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                          <button
                            type="button"
                            aria-pressed={days.includes(day)}
                            key={day}
                            disabled={pending}
                            className={days.includes(day) ? 'selected' : ''}
                            onClick={() =>
                              setDays(days.includes(day) ? days.filter((value) => value !== day) : [...days, day])
                            }
                          >
                            {t('周')}
                            {t('日一二三四五六'[day])}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="scheduled-form-grid">
                    <label>
                      {t('时区')}
                      <Combobox
                        aria-label={t('任务时区')}
                        value={timeZone}
                        onChange={setTimeZone}
                        options={[
                          ...new Set([
                            defaultZone,
                            'Asia/Shanghai',
                            'Asia/Tokyo',
                            'Europe/London',
                            'America/New_York',
                            'America/Los_Angeles',
                            'UTC',
                          ]),
                        ]}
                        emptyMessage={t('可直接输入其他 IANA 时区')}
                        disabled={pending}
                        required
                      />
                    </label>
                  </div>
                  <div className="scheduled-preview">
                    <Icon name="clock" size={14} />
                    <span>{preview}</span>
                  </div>
                </>
              )}
              {triggerKind === 'event' && (
                <>
                  <div className="scheduled-form-grid">
                    <label>
                      {t('事件')}
                      <Select
                        aria-label={t('触发事件')}
                        value={eventKind}
                        onChange={(event) => setEventKind(event.target.value as EventKind)}
                        disabled={pending}
                      >
                        <option value="file">{t('文件夹里有文件变化')}</option>
                        <option value="message">{t('收到 IM 消息')}</option>
                        <option value="automation">{t('另一个自动化结束')}</option>
                      </Select>
                    </label>
                  </div>
                  {eventKind === 'file' && (
                    <div className="scheduled-folder">
                      <input
                        aria-label={t('监视的文件夹')}
                        value={folder}
                        onChange={(event) => setFolder(event.target.value)}
                        placeholder={t('本机文件夹的完整路径')}
                        spellCheck={false}
                        disabled={pending}
                      />
                      <button
                        type="button"
                        className="companion-button"
                        disabled={pending}
                        onClick={() =>
                          void window.aelion.chooseFolder().then(
                            (value) => value && setFolder(value),
                            () => {},
                          )
                        }
                      >
                        {t('选择…')}
                      </button>
                    </div>
                  )}
                  {eventKind === 'message' && (
                    <div className="scheduled-form-grid">
                      <label>
                        {t('来自')}
                        <Select
                          aria-label={t('来自哪个连接器')}
                          value={connectorId}
                          onChange={(event) => setConnectorId(event.target.value)}
                          disabled={pending}
                        >
                          <option value="">{t('任意连接器')}</option>
                          {connectors.map((connector) => (
                            <option key={connector.id} value={connector.id}>
                              {t(CONNECTOR_PLATFORM_NAMES[connector.platform])} · {connector.account}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label>
                        {t('包含关键词')}
                        <input
                          aria-label={t('包含关键词')}
                          value={keyword}
                          onChange={(event) => setKeyword(event.target.value)}
                          maxLength={100}
                          placeholder={t('留空表示任意消息')}
                          disabled={pending}
                        />
                      </label>
                    </div>
                  )}
                  {eventKind === 'automation' && (
                    <div className="scheduled-form-grid">
                      <label>
                        {t('前一个自动化')}
                        <Select
                          aria-label={t('前一个自动化')}
                          value={after}
                          onChange={(event) => setAfter(event.target.value)}
                          disabled={pending}
                        >
                          <option value="">{t('请选择')}</option>
                          {others.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.title}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label>
                        {t('结束方式')}
                        <Select
                          aria-label={t('结束方式')}
                          value={outcome}
                          onChange={(event) => setOutcome(event.target.value as typeof outcome)}
                          disabled={pending}
                        >
                          <option value="completed">{t('成功完成后')}</option>
                          <option value="failed">{t('没有完成时')}</option>
                          <option value="any">{t('无论结果')}</option>
                        </Select>
                      </label>
                    </div>
                  )}
                </>
              )}
              {triggerKind === 'webhook' && (
                <div className="scheduled-webhook">
                  {webhookUrl ? (
                    <>
                      <div className="scheduled-webhook-url">
                        <code>{webhookUrl}</code>
                        <button
                          type="button"
                          className="companion-button"
                          onClick={() =>
                            void navigator.clipboard.writeText(webhookUrl).then(() => {
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1600);
                            })
                          }
                        >
                          {copied ? t('已复制') : t('复制')}
                        </button>
                      </div>
                      <p>
                        {t('用 POST 调用，请求体（JSON 或文本）会作为触发信息交给 Bot。这个地址含有密钥，不要公开。')}
                      </p>
                    </>
                  ) : (
                    <p>
                      {saved?.kind === 'webhook' && !webhookOrigin
                        ? t('本机 Webhook 服务没有启动，端口可能被占用。')
                        : t('保存后显示调用地址。应用只在本机（127.0.0.1）监听，其他设备需要你自己配置转发。')}
                    </p>
                  )}
                </div>
              )}
              {triggerKind === 'script' && (
                <>
                  <label className="scheduled-script">
                    {t('检查脚本（JavaScript）')}
                    <textarea
                      aria-label={t('检查脚本')}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      rows={9}
                      maxLength={20000}
                      spellCheck={false}
                      disabled={pending}
                    />
                  </label>
                  <div className="scheduled-form-grid">
                    <label>
                      {t('检查间隔（分钟）')}
                      <input
                        aria-label={t('检查间隔分钟')}
                        type="number"
                        min={1}
                        max={1440}
                        value={checkMinutes}
                        onChange={(event) => setCheckMinutes(Number(event.target.value))}
                        disabled={pending}
                        required
                      />
                    </label>
                  </div>
                  <p className="scheduled-local-note">
                    {t(
                      '脚本在隔离的沙箱里运行，只能用 tools.fetch 访问公网地址。返回 { fire: true, message } 时触发，state 会保存到下次检查。',
                    )}
                  </p>
                </>
              )}
              {task && !task.needsReview && (
                <div className="scheduled-form-grid">
                  <label>
                    {t('状态')}
                    <Select
                      aria-label={t('任务状态')}
                      value={status}
                      onChange={(event) => setStatus(event.target.value as ScheduledTaskStatus)}
                      disabled={pending}
                    >
                      {Object.entries(statuses).map(([value, label]) => (
                        <option value={value} key={value}>
                          {t(label)}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
              )}
              <p className="scheduled-local-note">
                {triggerKind === 'schedule'
                  ? t('客户端运行时自动执行，结果发送到此会话。')
                  : t('触发后在此会话执行；每个自动化每分钟最多运行一次，期间的多次触发会合并。')}
              </p>
            </section>
            {live?.lastRun && (
              <div
                className={`scheduled-last-run ${['failed', 'interrupted'].includes(live.lastRun.status) ? 'is-failed' : ''}`}
              >
                <div>
                  <span className="scheduled-status-dot" />
                  <span>{t(executionLabels[live.lastRun.status])}</span>
                </div>
                <time>{new Date(live.lastRun.finishedAt || live.lastRun.startedAt).toLocaleString(language)}</time>
              </div>
            )}
            {(error || live?.error) && (
              <p className="scheduled-error" role="alert">
                {error || live?.error}
              </p>
            )}
          </div>
          <footer>
            {deleting ? (
              <div className="scheduled-delete-confirm">
                <span>{t('删除此自动化？')}</span>
                <button
                  ref={deleteCancel}
                  type="button"
                  className="companion-button"
                  disabled={pending}
                  onClick={() => setDeleting(false)}
                >
                  {t('取消')}
                </button>
                <button
                  type="button"
                  className="companion-button scheduled-confirm-delete"
                  disabled={pending}
                  onClick={() => void run(() => window.aelion.deleteScheduledTask(task!.id))}
                >
                  {pending ? t('正在删除…') : t('确认删除')}
                </button>
              </div>
            ) : (
              <>
                {task && (
                  <button
                    ref={deleteButton}
                    type="button"
                    className="scheduled-delete"
                    aria-label={t('删除自动化')}
                    disabled={pending}
                    onClick={() => setDeleting(true)}
                  >
                    <Icon name="trash" size={14} />
                    {t('删除')}
                  </button>
                )}
                <div className="scheduled-save-actions">
                  {task && !task.needsReview && (
                    <button
                      type="button"
                      className="companion-button"
                      title={dirty ? t('请先保存修改') : undefined}
                      disabled={pending || dirty || Boolean(live && taskExecuting(live))}
                      onClick={() => void run(() => window.aelion.runScheduledTask(task.id))}
                    >
                      {t('立即运行')}
                    </button>
                  )}
                  {task?.needsReview ? (
                    <button
                      type="button"
                      className="companion-button companion-primary"
                      disabled={pending || !ready}
                      onClick={() => void save('enabled')}
                    >
                      {pending ? t('保存中…') : t('看过了，启用')}
                    </button>
                  ) : (
                    <button className="companion-button companion-primary" disabled={pending || !ready}>
                      {pending ? t('保存中…') : task ? t('保存修改') : t('创建自动化')}
                    </button>
                  )}
                </div>
              </>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
}
