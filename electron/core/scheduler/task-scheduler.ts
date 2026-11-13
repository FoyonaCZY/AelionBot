// Automations: a prompt sent to a conversation when its trigger fires. Time triggers are checked every second; the
// others (webhook, folder changes, connector messages, another automation finishing, a sandboxed script) report a
// firing here, which waits until the conversation is free and the automation has cooled down, merging with later
// firings meanwhile. Each run is one durable occurrence that is never replayed after a restart.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Store } from '../storage/store';
import { groupPending } from '../../../shared/types/group-types';
import {
  nextTaskTime,
  sameTaskTarget,
  taskExecuting,
  type AutomationSignal,
  type AutomationTrigger,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskUpdate,
  type TaskSchedule,
  type TaskTarget,
  type ScheduledTrigger,
  type ScheduledExecution,
} from '../../../shared/types/scheduled-types';
import type { HarnessRunOptions } from '../agent/peer-runtime-types';
import { AppError } from '../../../shared/errors';

interface Dispatcher {
  ready: (target: TaskTarget) => boolean;
  send: (target: TaskTarget, prompt: string, trigger: ScheduledTrigger) => void;
}
export interface ScriptOutcome {
  fire: boolean;
  message: string;
  state: unknown;
}
/** What automations need from the rest of the app; absent parts disable the triggers that use them. */
export interface AutomationHooks {
  /** Runs a script trigger's check in the sandbox. */
  checkScript?(code: string, state: unknown, signal: AbortSignal): Promise<ScriptOutcome>;
  /** Asks the user whether a Bot may watch a folder, as reading it would ask. */
  approveFolder?(botId: string, runId: string, path: string, signal: AbortSignal): Promise<void>;
  /** The local webhook server's origin, such as http://127.0.0.1:47811, while it listens. */
  webhookOrigin?(): string | undefined;
}

/** A merged firing keeps this much of what happened; the newest first. */
const SIGNAL_CHARS = 8000;
/** Event triggers run at most once a minute, so a busy folder or webhook cannot flood a conversation. */
const COOLDOWN_MS = 60_000;
/** Scripts keep at most this much state between checks. */
const SCRIPT_STATE_CHARS = 16_000;
/** A script that fails this many checks in a row is paused with its error. */
const SCRIPT_FAILURES = 3;

function required(value: unknown, label: string, max: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error(`${label}无效`);
  return value.trim();
}
export function validateTaskSchedule(value: unknown): TaskSchedule {
  if (!value || typeof value !== 'object') throw new Error('请设置执行时间');
  const s = value as Record<string, unknown>;
  const timeZone = required(s.timeZone, '时区', 100);
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
  } catch {
    throw new Error('时区无效，请使用 Asia/Shanghai 等时区名称');
  }
  if (s.kind === 'once') {
    const at = required(s.at, '执行时间', 80);
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(at) || !Number.isFinite(Date.parse(at)))
      throw new Error('一次性任务需要包含时区的完整日期时间');
    return { kind: 'once', at: new Date(at).toISOString(), timeZone };
  }
  if (s.kind === 'interval') {
    if (!Number.isInteger(s.minutes) || Number(s.minutes) < 1 || Number(s.minutes) > 525600)
      throw new Error('间隔应为 1–525600 分钟');
    return { kind: 'interval', minutes: Number(s.minutes), timeZone };
  }
  if (s.kind !== 'daily' && s.kind !== 'weekly') throw new Error('不支持的重复方式');
  if (typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new Error('时间格式应为 HH:mm');
  if (s.kind === 'daily') return { kind: 'daily', time: s.time, timeZone };
  if (
    !Array.isArray(s.weekdays) ||
    !s.weekdays.length ||
    s.weekdays.length > 7 ||
    s.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new Error('请选择星期（0 为周日，1–6 为周一到周六）');
  return { kind: 'weekly', time: s.time, weekdays: [...new Set(s.weekdays)].sort(), timeZone };
}

/** The webhook address path of an automation; the app's local server adds its origin. */
const webhookPath = (task: Pick<ScheduledTask, 'id' | 'trigger'>) =>
  task.trigger.kind === 'webhook' ? `/hooks/${task.id}/${task.trigger.token}` : undefined;
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** A merged firing: the newest detail first, older ones kept while they fit. */
function merge(previous: AutomationSignal | undefined, next: AutomationSignal): AutomationSignal {
  if (!previous || previous.kind !== next.kind) return { ...next, detail: next.detail.slice(0, SIGNAL_CHARS) };
  const count = (previous.count || 1) + (next.count || 1);
  return {
    kind: next.kind,
    count,
    detail: `${next.detail}\n---\n${previous.detail}`.slice(0, SIGNAL_CHARS),
  };
}

export class TaskScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closed = false;
  /** Script triggers being checked now, by automation ID. */
  private checking = new Map<string, AbortController>();
  /** Consecutive failed checks, by automation ID. */
  private scriptFailures = new Map<string, number>();
  constructor(
    private store: Store,
    private dispatcher: Dispatcher,
    private changed: () => void,
    private clock: () => number = Date.now,
    private hooks: AutomationHooks = {},
  ) {
    store.data.scheduledTasks ||= [];
    let dirty = false;
    // Every automation was a scheduled task with a `schedule` before triggers existed.
    for (const task of store.data.scheduledTasks as Array<ScheduledTask & { schedule?: TaskSchedule }>)
      if (!task.trigger && task.schedule) {
        task.trigger = { kind: 'schedule', schedule: task.schedule };
        delete task.schedule;
        dirty = true;
      }
    // Existing runs are inspected after the chat queues restore their state. Never replay a claimed occurrence.
    if (this.reconcile() || dirty) store.save();
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private save() {
    this.store.save();
    this.changed();
  }
  list(target?: TaskTarget) {
    return structuredClone(
      this.store.data.scheduledTasks.filter((task) => !target || sameTaskTarget(task.target, target)),
    );
  }
  private target(value: TaskTarget) {
    if (!value || !['bot', 'group'].includes(value.kind) || typeof value.id !== 'string')
      throw new Error('任务会话无效');
    const sessionId = value.sessionId || undefined;
    if (
      sessionId !== undefined &&
      (value.kind !== 'bot' ||
        !this.store.data.workSessions?.some((session) => session.id === sessionId && session.botId === value.id))
    )
      throw new AppError('session.not_found', '工作会话不存在');
    if (value.kind === 'bot') this.store.bot(value.id);
    else if (
      !this.store.data.groups.some(
        (group) =>
          group.id === value.id &&
          group.members.some((member) => !member.leftAt && this.store.data.bots.some((bot) => bot.id === member.id)),
      )
    )
      throw new Error('群聊不存在或没有 Bot 成员');
    return { kind: value.kind, id: value.id, ...(sessionId ? { sessionId } : {}) };
  }
  private get(id: string) {
    const task = this.store.data.scheduledTasks.find((task) => task.id === id);
    if (!task) throw new AppError('automation.not_found', '自动化不存在');
    return task;
  }
  /** A trigger as given, checked; a webhook keeps its secret when it stays a webhook. */
  private trigger(input: ScheduledTaskInput | ScheduledTaskUpdate, self?: ScheduledTask): AutomationTrigger {
    const value = (input.trigger ?? (input.schedule ? { kind: 'schedule', schedule: input.schedule } : undefined)) as
      Record<string, unknown> | undefined;
    if (!value || typeof value !== 'object') throw new AppError('automation.trigger_required', '请设置触发条件');
    switch (value.kind) {
      case 'schedule':
        return { kind: 'schedule', schedule: validateTaskSchedule(value.schedule) };
      case 'webhook':
        return {
          kind: 'webhook',
          token: self?.trigger.kind === 'webhook' ? self.trigger.token : randomBytes(24).toString('base64url'),
        };
      case 'file': {
        const path = required(value.path, '文件夹', 1000);
        let folder = false;
        try {
          folder = isAbsolute(path) && statSync(path).isDirectory();
        } catch {}
        if (!folder) throw new AppError('automation.folder_missing', '请选择本机上一个已存在的文件夹（完整路径）');
        return { kind: 'file', path };
      }
      case 'message': {
        const keyword =
            value.keyword === undefined || value.keyword === '' ? undefined : required(value.keyword, '关键词', 100),
          connectorId =
            value.connectorId === undefined || value.connectorId === ''
              ? undefined
              : required(value.connectorId, '连接器', 80);
        return { kind: 'message', ...(connectorId ? { connectorId } : {}), ...(keyword ? { keyword } : {}) };
      }
      case 'automation': {
        const automationId = required(value.automationId, '前置自动化', 80);
        if (automationId === self?.id) throw new AppError('automation.self_chain', '自动化不能在自己完成后触发自己');
        this.get(automationId);
        const outcome = ['completed', 'failed', 'any'].includes(value.outcome as string) ? value.outcome : 'completed';
        return { kind: 'automation', automationId, outcome: outcome as 'completed' | 'failed' | 'any' };
      }
      case 'script': {
        if (typeof value.code !== 'string' || !value.code.trim() || value.code.length > 20000)
          throw new AppError('automation.script_invalid', '检查脚本需要 1–20000 字符的 JavaScript');
        if (!Number.isInteger(value.minutes) || Number(value.minutes) < 1 || Number(value.minutes) > 1440)
          throw new AppError('automation.script_interval', '检查间隔应为 1–1440 分钟');
        return { kind: 'script', code: value.code, minutes: Number(value.minutes) };
      }
      default:
        throw new AppError('automation.trigger_invalid', '不支持的触发方式');
    }
  }
  /** When a newly enabled trigger next acts: a time trigger's next run, a script's first check right away. */
  private firstRun(trigger: AutomationTrigger) {
    if (trigger.kind === 'schedule') {
      const next = nextTaskTime(trigger.schedule, this.clock());
      if (!next) throw new AppError('schedule.time_passed', '执行时间应晚于当前时间');
      return next;
    }
    if (trigger.kind === 'script') return this.now();
  }
  create(input: ScheduledTaskInput, createdBy: ScheduledTask['createdBy'] = { kind: 'user', id: 'user', name: '你' }) {
    if (this.closed) throw new Error('客户端正在退出');
    const target = this.target(input?.target),
      title = required(input.title, '任务名称', 80),
      prompt = required(input.prompt, '任务内容', 8000),
      trigger = this.trigger(input);
    // A Bot's script runs on this computer every few minutes; the user reads it before it does.
    const review = createdBy.kind === 'bot' && trigger.kind === 'script';
    const nextRunAt = review ? undefined : this.firstRun(trigger);
    const comparable = (value: AutomationTrigger) =>
      JSON.stringify(value.kind === 'webhook' ? { kind: 'webhook' } : value);
    const existing = this.store.data.scheduledTasks.find(
      (task) =>
        sameTaskTarget(task.target, target) &&
        task.status !== 'completed' &&
        task.title === title &&
        task.prompt === prompt &&
        comparable(task.trigger) === comparable(trigger),
    );
    if (existing) return structuredClone(existing);
    if (this.store.data.scheduledTasks.length >= 1000 || this.list(target).length >= 100)
      throw new Error('自动化数量已达上限');
    const task: ScheduledTask = {
      id: randomUUID(),
      target,
      title,
      prompt,
      trigger,
      status: review ? 'paused' : 'enabled',
      ...(nextRunAt ? { nextRunAt } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
      createdBy,
      ...(review ? { needsReview: true } : {}),
    };
    this.store.data.scheduledTasks.push(task);
    this.save();
    return structuredClone(task);
  }
  update(input: ScheduledTaskUpdate, by: 'user' | 'bot' = 'user') {
    const task = this.get(required(input?.id, '任务 ID', 80));
    this.target(task.target);
    const title = input.title === undefined ? task.title : required(input.title, '任务名称', 80),
      prompt = input.prompt === undefined ? task.prompt : required(input.prompt, '任务内容', 8000),
      trigger = input.trigger === undefined && input.schedule === undefined ? task.trigger : this.trigger(input, task),
      status = input.status ?? task.status;
    if (!['enabled', 'paused', 'completed'].includes(status)) throw new Error('无效任务状态');
    const triggerChanged = JSON.stringify(trigger) !== JSON.stringify(task.trigger);
    // A Bot's changed script needs reading again, and only the user can turn on one waiting for that.
    const needsReview =
      (task.needsReview && by === 'bot') || (by === 'bot' && trigger.kind === 'script' && triggerChanged);
    if (needsReview && status === 'enabled')
      throw new AppError('automation.review_required', '这个检查脚本需要用户在自动化面板里查看并启用');
    let nextRunAt = task.nextRunAt;
    if (status === 'enabled' && (status !== task.status || triggerChanged || (!nextRunAt && !taskExecuting(task))))
      nextRunAt = this.firstRun(trigger);
    if (status !== 'enabled') nextRunAt = undefined;
    Object.assign(task, { title, prompt, trigger, status, nextRunAt, updatedAt: this.now(), error: undefined });
    if (needsReview) task.needsReview = true;
    else delete task.needsReview;
    if (status !== 'enabled' || triggerChanged) delete task.pending;
    if (triggerChanged) delete task.scriptState;
    this.checking.get(task.id)?.abort();
    this.save();
    return structuredClone(task);
  }
  remove(id: string) {
    this.get(id);
    this.checking.get(id)?.abort();
    this.store.data.scheduledTasks = this.store.data.scheduledTasks.filter((task) => task.id !== id);
    this.save();
  }
  /** Removes a group's or work session's tasks; a Bot's (no `sessionId`) include those of its work sessions. */
  removeTarget(target: TaskTarget) {
    this.store.data.scheduledTasks = this.store.data.scheduledTasks.filter(
      (task) =>
        !(
          task.target.kind === target.kind &&
          task.target.id === target.id &&
          (!target.sessionId || task.target.sessionId === target.sessionId)
        ),
    );
    this.save();
  }
  runNow(id: string) {
    const task = this.get(id);
    this.target(task.target);
    if (taskExecuting(task)) throw new Error('这项任务正在执行');
    if (!this.dispatcher.ready(task.target)) throw new Error('会话正在处理其他任务，请稍后再试');
    this.dispatch(task, this.now(), true);
    this.save();
  }
  /**
   * Reports a firing of a non-time trigger. It runs once the conversation is free and the automation has cooled
   * down; firings meanwhile are merged into it. Returns whether the automation takes it.
   */
  fire(id: string, signal: AutomationSignal) {
    const task = this.store.data.scheduledTasks.find((item) => item.id === id);
    if (!task || task.status !== 'enabled' || task.trigger.kind !== signal.kind) return false;
    task.pending = { ...merge(task.pending, signal), at: this.now() };
    this.save();
    this.tick();
    return true;
  }
  /** The automation a webhook call is for, when its secret matches and it is on. */
  webhook(id: string, token: string) {
    const task = this.store.data.scheduledTasks.find((item) => item.id === id);
    if (!task || task.trigger.kind !== 'webhook' || !sameSecret(task.trigger.token, token)) return;
    return task.status === 'enabled' ? task : undefined;
  }
  /** A message from a connector: fires the automations waiting for it. */
  connectorMessage(input: { connectorId: string; platform: string; sender: string; text: string }) {
    const text = input.text.trim();
    if (!text) return;
    for (const task of this.store.data.scheduledTasks) {
      const trigger = task.trigger;
      if (trigger.kind !== 'message' || task.status !== 'enabled') continue;
      if (trigger.connectorId && trigger.connectorId !== input.connectorId) continue;
      if (trigger.keyword && !text.toLowerCase().includes(trigger.keyword.toLowerCase())) continue;
      this.fire(task.id, { kind: 'message', detail: `${input.platform}·${input.sender}：${text}` });
    }
  }
  /** Folders automations watch, for the watcher to follow. */
  watchedFolders() {
    return this.store.data.scheduledTasks.flatMap((task) =>
      task.trigger.kind === 'file' && task.status === 'enabled' ? [{ id: task.id, path: task.trigger.path }] : [],
    );
  }
  /** A trigger that stopped working, such as a folder that was removed: the automation pauses with the reason. */
  triggerFailed(id: string, error: string) {
    const task = this.store.data.scheduledTasks.find((item) => item.id === id);
    if (!task || task.status !== 'enabled') return;
    task.status = 'paused';
    task.error = error.slice(0, 300);
    task.nextRunAt = undefined;
    this.save();
  }
  /** Changes in an automation's folder. A run of that automation writing there does not fire it again. */
  folderChanged(id: string, paths: string[]) {
    const task = this.store.data.scheduledTasks.find((item) => item.id === id);
    if (!task || taskExecuting(task) || !paths.length) return;
    const shown = paths.slice(0, 50);
    this.fire(id, {
      kind: 'file',
      detail:
        `${task.trigger.kind === 'file' ? task.trigger.path : ''} 中有变化：\n` +
        shown.join('\n') +
        (paths.length > shown.length ? `\n……共 ${paths.length} 项` : ''),
    });
  }
  start() {
    if (this.timer || this.closed) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }
  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.checking.values()) controller.abort();
  }
  private outcome(task: ScheduledTask): Pick<ScheduledExecution, 'status' | 'error'> | undefined {
    const execution = task.lastRun;
    if (!execution) return;
    if (task.target.kind === 'bot') {
      const message = this.store.data.messages.find((message) => message.scheduled?.occurrenceId === execution.id);
      if (!message) return { status: 'interrupted', error: '执行记录未完整保存，未自动重试' };
      const run = message.runId ? this.store.data.runs.find((run) => run.id === message.runId) : undefined;
      if (run) return { status: run.status === 'running' ? 'running' : run.status, error: run.error };
      if (message.inputState === 'queued') return { status: 'queued' };
      return {
        status: message.inputState === 'cancelled' ? 'cancelled' : 'interrupted',
        error: '执行已中断，未自动重试',
      };
    }
    const room = this.store.data.groups.find((room) => room.id === task.target.id),
      message = room?.messages.find((message) => message.scheduled?.occurrenceId === execution.id);
    if (!message) return { status: 'interrupted', error: '群任务记录未完整保存，未自动重试' };
    const deliveries = this.store.data.groupDeliveries.filter(
      (delivery) => delivery.rootId === message.rootId && delivery.recipientId !== 'user',
    );
    if (deliveries.some((delivery) => groupPending(delivery.status)))
      return { status: deliveries.some((delivery) => delivery.status === 'running') ? 'running' : 'queued' };
    const failed = deliveries.find((delivery) =>
      ['failed', 'interrupted', 'cancelled', 'limited'].includes(delivery.status),
    );
    return failed
      ? {
          status:
            failed.status === 'interrupted' ? 'interrupted' : failed.status === 'cancelled' ? 'cancelled' : 'failed',
          error: failed.reason || '群任务未完成',
        }
      : { status: 'completed' };
  }
  private reconcile() {
    let dirty = false;
    const finished: ScheduledTask[] = [];
    for (const task of this.store.data.scheduledTasks) {
      if (!taskExecuting(task)) continue;
      const outcome = this.outcome(task);
      if (!outcome || (outcome.status === task.lastRun!.status && outcome.error === task.lastRun!.error)) continue;
      Object.assign(task.lastRun!, outcome);
      dirty = true;
      if (!['queued', 'running'].includes(outcome.status)) {
        task.lastRun!.finishedAt = this.now();
        task.error = outcome.error?.slice(0, 300);
        if (
          task.trigger.kind === 'schedule' &&
          task.trigger.schedule.kind === 'once' &&
          task.status === 'enabled' &&
          !task.nextRunAt
        )
          task.status = outcome.status === 'completed' ? 'completed' : 'paused';
        finished.push(task);
      }
    }
    // Automations that follow a finished one.
    for (const done of finished) {
      const completed = done.lastRun!.status === 'completed';
      for (const task of this.store.data.scheduledTasks) {
        const trigger = task.trigger;
        if (trigger.kind !== 'automation' || trigger.automationId !== done.id || task.status !== 'enabled') continue;
        if (trigger.outcome === 'completed' ? !completed : trigger.outcome === 'failed' ? completed : false) continue;
        task.pending = {
          ...merge(task.pending, {
            kind: 'automation',
            detail: `自动化「${done.title}」${completed ? '已完成' : `没有完成：${done.lastRun!.error || done.lastRun!.status}`}`,
          }),
          at: this.now(),
        };
      }
    }
    return dirty;
  }
  private dispatch(task: ScheduledTask, scheduledFor: string, manual = false, signal?: AutomationSignal) {
    const execution: ScheduledExecution = { id: randomUUID(), scheduledFor, startedAt: this.now(), status: 'queued' };
    task.lastRun = execution;
    task.error = undefined;
    const schedule = task.trigger.kind === 'schedule' ? task.trigger.schedule : undefined;
    if (
      schedule &&
      (!manual || schedule.kind === 'once' || (task.nextRunAt && Date.parse(task.nextRunAt) <= this.clock()))
    )
      task.nextRunAt =
        task.status === 'enabled' && schedule.kind !== 'once'
          ? nextTaskTime(schedule, Math.max(this.clock(), Date.parse(scheduledFor)), Date.parse(scheduledFor))
          : undefined;
    try {
      this.dispatcher.send(task.target, task.prompt, {
        taskId: task.id,
        occurrenceId: execution.id,
        title: task.title,
        scheduledFor,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      execution.status = 'failed';
      execution.finishedAt = this.now();
      execution.error = String((error as Error).message).slice(0, 300);
      task.error = execution.error;
      task.status = 'paused';
      task.nextRunAt = undefined;
    }
  }
  /** Starts a script trigger's check; its result comes back as a firing, or as the automation's error. */
  private check(task: ScheduledTask) {
    const trigger = task.trigger;
    if (trigger.kind !== 'script' || !this.hooks.checkScript || this.checking.has(task.id)) return;
    const controller = new AbortController();
    this.checking.set(task.id, controller);
    task.nextRunAt = new Date(this.clock() + trigger.minutes * 60000).toISOString();
    const done = () => {
      if (this.checking.get(task.id) === controller) this.checking.delete(task.id);
    };
    void this.hooks
      .checkScript(trigger.code, task.scriptState, controller.signal)
      .then((outcome) => {
        done();
        const current = this.store.data.scheduledTasks.find((item) => item.id === task.id);
        // An automation changed or removed meanwhile ignores the old script's answer.
        if (controller.signal.aborted || !current || current.trigger !== trigger) return;
        if (JSON.stringify(outcome.state ?? null).length > SCRIPT_STATE_CHARS)
          throw new Error(`state 超过 ${SCRIPT_STATE_CHARS} 字符`);
        this.scriptFailures.delete(task.id);
        current.scriptState = outcome.state ?? undefined;
        current.error = undefined;
        this.save();
        if (outcome.fire) this.fire(task.id, { kind: 'script', detail: outcome.message || '检查脚本触发' });
      })
      .catch((error) => {
        done();
        const current = this.store.data.scheduledTasks.find((item) => item.id === task.id);
        if (controller.signal.aborted || !current) return;
        const failures = (this.scriptFailures.get(task.id) || 0) + 1;
        this.scriptFailures.set(task.id, failures);
        current.error = `检查脚本出错：${String((error as Error).message).slice(0, 260)}`;
        if (failures >= SCRIPT_FAILURES) {
          current.status = 'paused';
          current.nextRunAt = undefined;
          current.error += `（连续 ${failures} 次出错，已暂停）`;
          this.scriptFailures.delete(task.id);
        }
        this.save();
      });
  }
  tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      let dirty = this.reconcile();
      for (const task of this.store.data.scheduledTasks) {
        if (task.status !== 'enabled') continue;
        try {
          this.target(task.target);
        } catch (error) {
          task.status = 'paused';
          task.error = (error as Error).message;
          task.nextRunAt = undefined;
          dirty = true;
          continue;
        }
        if (task.trigger.kind === 'script' && task.nextRunAt && Date.parse(task.nextRunAt) <= this.clock()) {
          this.check(task);
          dirty = true;
        }
        if (taskExecuting(task) || !this.dispatcher.ready(task.target)) continue;
        if (task.pending) {
          const last = task.lastRun ? Date.parse(task.lastRun.startedAt) : 0;
          if (this.clock() - last < COOLDOWN_MS) continue;
          const { at, ...signal } = task.pending;
          delete task.pending;
          this.dispatch(task, at, false, signal);
          dirty = true;
          continue;
        }
        if (task.trigger.kind !== 'schedule' || !task.nextRunAt || Date.parse(task.nextRunAt) > this.clock()) continue;
        this.dispatch(task, task.nextRunAt);
        dirty = true;
      }
      if (dirty) this.save();
    } finally {
      this.ticking = false;
    }
  }
  async invoke(
    botId: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    _options: HarnessRunOptions,
  ) {
    const run = this.store.data.runs.find((run) => run.id === runId && run.botId === botId && run.status === 'running');
    if (signal.aborted || !run) throw new AppError('schedule.run_ended', '当前任务已结束');
    const bot = this.store.bot(botId),
      // An automation made in a work session runs in that session, with its history and folder.
      target: TaskTarget = run.groupOrigin
        ? { kind: 'group', id: run.groupOrigin.groupId }
        : { kind: 'bot', id: botId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) };
    if (
      target.kind === 'group' &&
      !this.store.data.groups.some(
        (room) => room.id === target.id && room.members.some((member) => member.id === botId && !member.leftAt),
      )
    )
      throw new Error('不能管理未加入群聊的自动化');
    // Watching a folder shows the Bot what changes there, so it asks like reading the folder would.
    const folder = (args.trigger as { kind?: unknown; path?: unknown } | undefined)?.kind === 'file' && args.trigger;
    const approve = async () => {
      if (!folder) return;
      if (!this.hooks.approveFolder) throw new AppError('automation.folder_unavailable', '这里不能监视本机文件夹');
      await this.hooks.approveFolder(botId, runId, String((folder as { path: unknown }).path), signal);
    };
    if (name === 'automations_list') return this.list(target);
    if (name === 'automation_create') {
      await approve();
      return this.created(
        this.create(
          { target, title: args.title as string, prompt: args.prompt as string, trigger: args.trigger as never },
          { kind: 'bot', id: botId, name: bot.name },
        ),
      );
    }
    const task = this.get(required(args.id, '任务 ID', 80));
    if (!sameTaskTarget(task.target, target))
      throw new AppError('schedule.target_mismatch', '只能管理当前会话的自动化');
    if (name === 'automation_update') {
      if (folder) await approve();
      return this.created(
        this.update(
          {
            id: task.id,
            title: args.title as string | undefined,
            prompt: args.prompt as string | undefined,
            trigger: args.trigger as never,
            status: args.status as ScheduledTask['status'] | undefined,
          },
          'bot',
        ),
      );
    }
    if (name === 'automation_delete') {
      this.remove(task.id);
      return { deleted: true };
    }
    throw new Error('未知自动化工具');
  }
  /** What a Bot learns about an automation it made: how to call a webhook, or that a script waits for the user. */
  private created(task: ScheduledTask) {
    return {
      ...task,
      ...(task.needsReview
        ? { note: '检查脚本需要用户在自动化面板查看后启用，目前是暂停状态。请告诉用户去启用。' }
        : {}),
      ...(task.trigger.kind === 'webhook'
        ? {
            webhook: {
              url: (this.hooks.webhookOrigin?.() || '') + webhookPath(task),
              note: '应用只在本机 127.0.0.1 监听；用 POST 调用，请求体（JSON 或文本）会作为触发信息交给本次执行。',
            },
          }
        : {}),
    };
  }
}
